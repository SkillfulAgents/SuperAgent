import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { transformWithEsbuild } from 'vite'

const MINIMUM_SSIM = 0.995

type PointerPosition = 'none' | 'center' | 'edge'

interface VisualFixture {
  name: string
  motif: 'flow_3d' | 'pulse'
  state: 'working' | 'idle' | 'alert'
  width: number
  height: number
  time: number
  seed: number
  pointer: PointerPosition
  dpr: 1 | 2
  zeroSizeFirst?: boolean
}

const motifStates: Array<Pick<VisualFixture, 'motif' | 'state' | 'seed'>> = [
  { motif: 'flow_3d', state: 'working', seed: 7 },
  { motif: 'flow_3d', state: 'idle', seed: 13 },
  { motif: 'pulse', state: 'alert', seed: 5 },
]
const cardSizes = [
  { name: 'small', width: 282, height: 132 },
  { name: 'wide', width: 576, height: 276 },
]
const timestamps = [0, 735]
const pointers: PointerPosition[] = ['none', 'center', 'edge']
const dprs: Array<1 | 2> = [1, 2]

const fixtures: VisualFixture[] = []
for (const motifState of motifStates) {
  for (const size of cardSizes) {
    for (const time of timestamps) {
      for (const pointer of pointers) {
        for (const dpr of dprs) {
          fixtures.push({
            ...motifState,
            ...size,
            time,
            pointer,
            dpr,
            name: [
              motifState.motif,
              motifState.state,
              size.name,
              `t${time}`,
              pointer,
              `dpr${dpr}`,
            ].join('-'),
          })
        }
      }
    }
  }
}

fixtures.push(
  {
    name: 'zero-size-resize-recovery',
    motif: 'flow_3d',
    state: 'working',
    width: 576,
    height: 276,
    time: 321,
    seed: 11,
    pointer: 'none',
    dpr: 1,
    zeroSizeFirst: true,
  },
  {
    name: 'one-row',
    motif: 'flow_3d',
    state: 'working',
    width: 30,
    height: 5,
    time: 123,
    seed: 3,
    pointer: 'center',
    dpr: 2,
  },
  {
    name: 'one-column',
    motif: 'pulse',
    state: 'alert',
    width: 5,
    height: 30,
    time: 456,
    seed: 3,
    pointer: 'edge',
    dpr: 2,
  }
)

test.describe('halftone alpha-bucket visual fidelity', () => {
  test('matches per-dot rendering across deterministic fixtures', async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    await page.goto('/')
    await page.setContent('<main id="halftone-visual-harness"></main>')
    const rendererPath = path.resolve(
      process.cwd(),
      'src/renderer/components/agents/halftone-renderer.ts'
    )
    const rendererSource = fs.readFileSync(rendererPath, 'utf8')
    const transformedRenderer = await transformWithEsbuild(
      rendererSource,
      rendererPath,
      { loader: 'ts', format: 'esm', target: 'es2022' }
    )
    await page.addScriptTag({
      type: 'module',
      content:
        `${transformedRenderer.code}\n` +
        'globalThis.__HalftoneFrameRenderer = HalftoneFrameRenderer;',
    })

    const comparison = await page.evaluate(
      async ({ visualFixtures, minimumSsim }) => {
        interface BrowserRenderer {
          resize(width: number, height: number): boolean
          draw(
            context: CanvasRenderingContext2D,
            time: number,
            strategy: 'per-dot' | 'alpha-buckets',
            pointerX?: number,
            pointerY?: number,
            pointerActive?: boolean
          ): number
        }
        interface BrowserRendererConstructor {
          new (options: {
            motif: string
            state: 'working' | 'idle' | 'alert'
            color: string
            spacing: number
            maxRadius: number
            vignette: number
            contrast: number
            seed: number
          }): BrowserRenderer
        }
        interface FailureArtifact {
          name: string
          reference: string
          candidate: string
          difference: string
        }

        const Renderer = (
          globalThis as typeof globalThis & {
            __HalftoneFrameRenderer?: BrowserRendererConstructor
          }
        ).__HalftoneFrameRenderer
        if (!Renderer) throw new Error('Injected Halftone renderer is unavailable')
        const harnessRoot = document.querySelector('#halftone-visual-harness')
        if (!harnessRoot) throw new Error('Halftone visual harness root is missing')
        const harness = harnessRoot

        function createCanvas(width: number, height: number, dpr: number) {
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(width * dpr)
          canvas.height = Math.round(height * dpr)
          canvas.style.width = `${width}px`
          canvas.style.height = `${height}px`
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Canvas2D is unavailable')
          context.setTransform(dpr, 0, 0, dpr, 0, 0)
          harness.appendChild(canvas)
          return { canvas, context }
        }

        function normalizedLuminance(image: ImageData): Float32Array {
          const normalized = new Float32Array(image.width * image.height)
          for (let pixel = 0; pixel < normalized.length; pixel++) {
            const offset = pixel * 4
            const alpha = image.data[offset + 3] / 255
            const inkLuminance =
              image.data[offset] * 0.2126 +
              image.data[offset + 1] * 0.7152 +
              image.data[offset + 2] * 0.0722
            normalized[pixel] = 255 * (1 - alpha) + inkLuminance * alpha
          }
          return normalized
        }

        // Local 8×8-window SSIM after compositing both transparent canvases
        // over white and converting sRGB to luminance.
        function calculateSsim(
          reference: Float32Array,
          candidate: Float32Array,
          width: number,
          height: number
        ): number {
          const c1 = Math.pow(0.01 * 255, 2)
          const c2 = Math.pow(0.03 * 255, 2)
          const windowSize = 8
          let similarity = 0
          let windowCount = 0

          for (let top = 0; top < height; top += windowSize) {
            for (let left = 0; left < width; left += windowSize) {
              const right = Math.min(width, left + windowSize)
              const bottom = Math.min(height, top + windowSize)
              const count = (right - left) * (bottom - top)
              let referenceMean = 0
              let candidateMean = 0

              for (let y = top; y < bottom; y++) {
                for (let x = left; x < right; x++) {
                  const pixel = y * width + x
                  referenceMean += reference[pixel]
                  candidateMean += candidate[pixel]
                }
              }
              referenceMean /= count
              candidateMean /= count

              let referenceVariance = 0
              let candidateVariance = 0
              let covariance = 0
              for (let y = top; y < bottom; y++) {
                for (let x = left; x < right; x++) {
                  const pixel = y * width + x
                  const referenceDelta = reference[pixel] - referenceMean
                  const candidateDelta = candidate[pixel] - candidateMean
                  referenceVariance += referenceDelta * referenceDelta
                  candidateVariance += candidateDelta * candidateDelta
                  covariance += referenceDelta * candidateDelta
                }
              }
              const divisor = Math.max(1, count - 1)
              referenceVariance /= divisor
              candidateVariance /= divisor
              covariance /= divisor

              similarity +=
                ((2 * referenceMean * candidateMean + c1) *
                  (2 * covariance + c2)) /
                ((referenceMean * referenceMean +
                  candidateMean * candidateMean +
                  c1) *
                  (referenceVariance + candidateVariance + c2))
              windowCount++
            }
          }

          return similarity / windowCount
        }

        function createDifference(
          reference: Float32Array,
          candidate: Float32Array,
          width: number,
          height: number
        ): HTMLCanvasElement {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Difference Canvas2D is unavailable')
          const difference = context.createImageData(width, height)
          for (let pixel = 0; pixel < reference.length; pixel++) {
            const magnitude = Math.min(
              255,
              Math.abs(reference[pixel] - candidate[pixel]) * 8
            )
            const offset = pixel * 4
            difference.data[offset] = magnitude
            difference.data[offset + 1] = 0
            difference.data[offset + 2] = magnitude
            difference.data[offset + 3] = 255
          }
          context.putImageData(difference, 0, 0)
          return canvas
        }

        const results: Array<{
          name: string
          ssim: number
          referenceDots: number
          candidateDots: number
        }> = []
        const failures: FailureArtifact[] = []

        for (const fixture of visualFixtures) {
          harness.replaceChildren()
          const referenceCanvas = createCanvas(
            fixture.width,
            fixture.height,
            fixture.dpr
          )
          const candidateCanvas = createCanvas(
            fixture.width,
            fixture.height,
            fixture.dpr
          )
          const options = {
            motif: fixture.motif,
            state: fixture.state,
            color: '#111827',
            spacing: 6,
            maxRadius: 1.6,
            vignette: 0.22,
            contrast: 1.6,
            seed: fixture.seed,
          }
          const referenceRenderer = new Renderer(options)
          const candidateRenderer = new Renderer(options)
          if (fixture.zeroSizeFirst) {
            if (referenceRenderer.resize(0, 0) || candidateRenderer.resize(0, 0)) {
              throw new Error('Zero-sized renderer unexpectedly became ready')
            }
          }
          referenceRenderer.resize(fixture.width, fixture.height)
          candidateRenderer.resize(fixture.width, fixture.height)

          const pointerActive = fixture.pointer !== 'none'
          const pointerX =
            fixture.pointer === 'edge' ? fixture.width - 1 : fixture.width / 2
          const pointerY = fixture.height / 2
          let referenceDots = 0
          let candidateDots = 0
          // Four identical frames exercise deterministic pointer attack while
          // keeping animation time fixed.
          for (let frame = 0; frame < 4; frame++) {
            referenceDots = referenceRenderer.draw(
              referenceCanvas.context,
              fixture.time,
              'per-dot',
              pointerX,
              pointerY,
              pointerActive
            )
            candidateDots = candidateRenderer.draw(
              candidateCanvas.context,
              fixture.time,
              'alpha-buckets',
              pointerX,
              pointerY,
              pointerActive
            )
          }

          const physicalWidth = referenceCanvas.canvas.width
          const physicalHeight = referenceCanvas.canvas.height
          const referenceImage = referenceCanvas.context.getImageData(
            0,
            0,
            physicalWidth,
            physicalHeight
          )
          const candidateImage = candidateCanvas.context.getImageData(
            0,
            0,
            physicalWidth,
            physicalHeight
          )
          const normalizedReference = normalizedLuminance(referenceImage)
          const normalizedCandidate = normalizedLuminance(candidateImage)
          const ssim = calculateSsim(
            normalizedReference,
            normalizedCandidate,
            physicalWidth,
            physicalHeight
          )
          const difference = createDifference(
            normalizedReference,
            normalizedCandidate,
            physicalWidth,
            physicalHeight
          )

          results.push({
            name: fixture.name,
            ssim,
            referenceDots,
            candidateDots,
          })
          if (
            ssim < minimumSsim ||
            referenceDots !== candidateDots ||
            referenceDots === 0
          ) {
            failures.push({
              name: fixture.name,
              reference: referenceCanvas.canvas.toDataURL('image/png'),
              candidate: candidateCanvas.canvas.toDataURL('image/png'),
              difference: difference.toDataURL('image/png'),
            })
          }
        }

        return { results, failures }
      },
      { visualFixtures: fixtures, minimumSsim: MINIMUM_SSIM }
    )

    const summary = {
      normalization:
        'Composite transparent sRGB pixels over white, convert to luminance, average local 8x8-window SSIM.',
      threshold: MINIMUM_SSIM,
      fixtureCount: comparison.results.length,
      minimumObservedSsim: Math.min(...comparison.results.map((result) => result.ssim)),
      results: comparison.results,
    }
    console.log(
      `Halftone visual comparison: ${summary.fixtureCount} fixtures, ` +
        `minimum SSIM ${summary.minimumObservedSsim.toFixed(6)} ` +
        `(required ${MINIMUM_SSIM.toFixed(3)})`
    )
    await testInfo.attach('halftone-visual-summary.json', {
      body: Buffer.from(JSON.stringify(summary, null, 2)),
      contentType: 'application/json',
    })

    for (const failure of comparison.failures) {
      for (const kind of ['reference', 'candidate', 'difference'] as const) {
        await testInfo.attach(`${failure.name}-${kind}.png`, {
          body: Buffer.from(failure[kind].split(',')[1], 'base64'),
          contentType: 'image/png',
        })
      }
    }

    expect(
      comparison.failures.map((failure) => failure.name),
      `All fixtures must meet ${MINIMUM_SSIM} SSIM and render identical non-zero dot counts`
    ).toEqual([])
  })
})
