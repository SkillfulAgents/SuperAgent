import { describe, expect, it, vi } from 'vitest'
import {
  HALFTONE_ALPHA_BANDS,
  HALFTONE_MAX_ALPHA_ERROR,
  HalftoneFrameRenderer,
  type HalftoneDotScratch,
  alphaBandMidpoint,
  alphaToBand,
  countingSortDotIndices,
  createHalftoneDotScratch,
  drawAlphaBuckets,
  scaleHalftoneEasingRate,
} from './halftone-renderer'

function createContextMock() {
  const events: string[] = []
  const context = {
    globalAlpha: 1,
    fillStyle: '',
    clearRect: vi.fn(),
    beginPath: vi.fn(() => events.push('beginPath')),
    moveTo: vi.fn(() => events.push('moveTo')),
    arc: vi.fn(() => events.push('arc')),
    fill: vi.fn(() => events.push('fill')),
  } as unknown as CanvasRenderingContext2D
  return { context, events }
}

// Independent reference for the original field: rotate coordinates, evaluate
// all three waves at each offset, then light the finite-difference normal.
// This deliberately does not share the renderer's row/column factorization.
function referenceFlowDot(u: number, v: number, epsilon: number, time: number, seed: number) {
  const angle = (seed % 18) * 20 * (Math.PI / 180)
  const heightAt = (x: number, y: number) => {
    const rotatedU = 0.5 + (x - 0.5) * Math.cos(angle) - (y - 0.5) * Math.sin(angle)
    const rotatedV = 0.5 + (x - 0.5) * Math.sin(angle) + (y - 0.5) * Math.cos(angle)
    const t = time + seed % 1000
    return 0.65 +
      0.3 * Math.sin(rotatedU * 7 - t * 0.04) +
      0.2 * Math.sin(rotatedU * 13 + rotatedV * 6 - t * 0.05) +
      0.15 * Math.sin(rotatedU * 4 + rotatedV * 11 + t * 0.03)
  }
  const height = heightAt(u, v)
  const normalX = -(heightAt(u + epsilon, v) - height) / epsilon
  const normalY = -(heightAt(u, v + epsilon) - height) / epsilon
  const lit = Math.max(0, (normalX * 0.32 + normalY * -0.55 + 0.78) /
    (Math.hypot(normalX, normalY, 1) * Math.hypot(0.32, -0.55, 0.78)))
  return {
    alpha: Math.fround(Math.min(1, (0.18 + lit * 0.74) * 1.4 * 0.9) * 0.5),
    radius: Math.fround(Math.max(0.2, 0.45 + Math.max(0, height) * 1.9) * (1.3 / 2.4)),
  }
}

describe('halftone flow fidelity', () => {
  it.each(Array.from({ length: 18 }, (_, seed) => seed + 990))(
    'preserves the original wave field through time and resizes for seed %i',
    (seed) => {
      const renderer = new HalftoneFrameRenderer({
        motif: 'flow_3d', color: '#111827', spacing: 5, maxRadius: 1.3,
        contrast: 1.4, dim: 0.5, vignette: 0, seed,
      })
      const { context } = createContextMock()
      const alphas: number[] = []
      vi.mocked(context.fill).mockImplementation(() => alphas.push(context.globalAlpha))

      // Grow and shrink the caches, including a single row/column. Removing
      // vignette and pointer influence isolates the field's radius and lighting.
      for (const [width, height] of [[35, 25], [5, 30], [30, 5], [60, 40], [15, 15]]) {
        renderer.resize(width, height)
        const columns = renderer.columnCount
        const rows = renderer.rowCount
        for (const time of [0, 735, 20000]) {
          vi.mocked(context.arc).mockClear()
          alphas.length = 0
          expect(renderer.draw(context, time, 'per-dot')).toBe(columns * rows)
          for (let dot = 0; dot < columns * rows; dot++) {
            const column = dot % columns
            const row = Math.floor(dot / columns)
            const expected = referenceFlowDot(
              Math.fround(column / columns), Math.fround(row / rows), 0.5 / columns, time, seed
            )
            const [x, y, radius] = vi.mocked(context.arc).mock.calls[dot]
            expect(x).toBe((width - (columns - 1) * 5) / 2 + column * 5)
            expect(y).toBe((height - (rows - 1) * 5) / 2 + row * 5)
            expect(radius).toBeCloseTo(expected.radius, 7)
            expect(alphas[dot]).toBeCloseTo(expected.alpha, 7)
          }
        }
      }
    }
  )
})

describe('halftone alpha bands', () => {
  it('assigns alpha 0/1 and band-boundary values with at most 1/64 error', () => {
    const samples = [0, Number.EPSILON, 0.5 - Number.EPSILON, 0.5, 1]

    expect(alphaToBand(0)).toBe(0)
    expect(alphaToBand(0.5 - Number.EPSILON)).toBe(15)
    expect(alphaToBand(0.5)).toBe(16)
    expect(alphaToBand(1)).toBe(HALFTONE_ALPHA_BANDS - 1)

    for (const alpha of samples) {
      const midpoint = alphaBandMidpoint(alphaToBand(alpha))
      expect(Math.abs(midpoint - alpha)).toBeLessThanOrEqual(HALFTONE_MAX_ALPHA_ERROR)
    }
  })

  it('counting-sorts boundaries stably while preserving empty bands', () => {
    const scratch = createHalftoneDotScratch(6, 4)
    scratch.band.set([3, 0, 3, 1, 0, 3])

    countingSortDotIndices(scratch, 6)

    expect(Array.from(scratch.bandCounts)).toEqual([2, 1, 0, 3])
    expect(Array.from(scratch.bandOffsets)).toEqual([0, 2, 3, 3])
    expect(Array.from(scratch.sortedIndices)).toEqual([1, 4, 3, 0, 2, 5])
  })

  it('builds one path per non-empty band and moves before every arc', () => {
    const scratch = createHalftoneDotScratch(3, 4)
    scratch.x.set([10, 20, 30])
    scratch.y.set([11, 21, 31])
    scratch.radius.set([1, 2, 3])
    scratch.band.set([0, 3, 0])
    const { context, events } = createContextMock()

    drawAlphaBuckets(context, scratch, 3)

    expect(context.beginPath).toHaveBeenCalledTimes(2)
    expect(context.fill).toHaveBeenCalledTimes(2)
    expect(context.moveTo).toHaveBeenCalledTimes(3)
    expect(context.arc).toHaveBeenCalledTimes(3)
    expect(events).toEqual([
      'beginPath',
      'moveTo',
      'arc',
      'moveTo',
      'arc',
      'fill',
      'beginPath',
      'moveTo',
      'arc',
      'fill',
    ])
  })
})

describe('HalftoneFrameRenderer edge sizes', () => {
  it('recovers from zero size and safely renders one-row and one-column grids', () => {
    const renderer = new HalftoneFrameRenderer({
      motif: 'flow_3d',
      state: 'working',
      color: '#111827',
      spacing: 6,
      seed: 7,
    })
    const { context } = createContextMock()

    expect(renderer.resize(0, 0)).toBe(false)
    expect(renderer.draw(context, 0)).toBe(0)

    expect(renderer.resize(30, 5)).toBe(true)
    expect(renderer.columnCount).toBe(5)
    expect(renderer.rowCount).toBe(1)
    expect(renderer.draw(context, 123)).toBeGreaterThan(0)

    expect(renderer.resize(5, 30)).toBe(true)
    expect(renderer.columnCount).toBe(1)
    expect(renderer.rowCount).toBe(5)
    expect(renderer.draw(context, 456)).toBeGreaterThan(0)

    for (const call of vi.mocked(context.arc).mock.calls) {
      expect(call.slice(0, 3).every(Number.isFinite)).toBe(true)
    }
  })

  it('reuses typed-array buffers until the grid outgrows their capacity', () => {
    const renderer = new HalftoneFrameRenderer({
      motif: 'flow_3d',
      color: '#111827',
      spacing: 6,
    })
    const internals = renderer as unknown as {
      scratch: HalftoneDotScratch | null
      cellVignette: Float32Array
    }
    const { context } = createContextMock()

    expect(renderer.resize(240, 120)).toBe(true)
    const initialScratch = internals.scratch
    const initialVignette = internals.cellVignette
    renderer.draw(context, 0, 'alpha-buckets', 120, 60, true)
    expect(initialScratch?.influence.some((value) => value > 0)).toBe(true)

    expect(renderer.resize(180, 90)).toBe(true)
    expect(internals.scratch).toBe(initialScratch)
    expect(internals.cellVignette).toBe(initialVignette)
    expect(internals.scratch?.influence.slice(0, 450).every((value) => value === 0)).toBe(true)

    expect(renderer.resize(300, 150)).toBe(true)
    expect(internals.scratch).not.toBe(initialScratch)
    expect(internals.cellVignette).not.toBe(initialVignette)
  })
})

describe('halftone cursor easing', () => {
  it('preserves the 60 Hz easing response when a draw spans multiple frames', () => {
    const attack = 0.18
    const oneFrame = scaleHalftoneEasingRate(attack, 1)
    const twoFrames = scaleHalftoneEasingRate(attack, 2)
    const appliedTwice = oneFrame + (1 - oneFrame) * oneFrame

    expect(twoFrames).toBeCloseTo(appliedTwice)
    expect(scaleHalftoneEasingRate(attack, 0)).toBe(0)
  })
})
