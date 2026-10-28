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
