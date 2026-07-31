import { chromium, type Browser } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  halftoneBenchmarkResultSchema,
  type HalftoneBenchmarkFixture,
  type HalftoneBenchmarkGate,
  type HalftoneBenchmarkMode,
} from './halftone-benchmark-schema'

type BenchmarkModeName = 'headed-gpu' | 'headless-software'

const WIDE_CARD = { width: 576, height: 276, columns: 96, rows: 46 }
const VIEWPORT = { width: 1440, height: 1100 }
const DEVICE_PIXEL_RATIO = 2
const DEFAULT_WARMUP_COUNT = 60
const DEFAULT_SAMPLE_COUNT = 180
const CONFIRMATION_BANDS = [8, 16, 32, 64]

const modeDefinitions: Record<
  BenchmarkModeName,
  { headless: boolean; launchArgs: string[] }
> = {
  'headed-gpu': {
    headless: false,
    launchArgs: [
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--ignore-gpu-blocklist',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  },
  'headless-software': {
    headless: true,
    launchArgs: [
      '--disable-gpu',
      '--disable-gpu-rasterization',
      '--disable-accelerated-2d-canvas',
    ],
  },
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function readCount(name: string, fallback: number): number {
  const value = readOption(name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

function requestedModes(): BenchmarkModeName[] {
  const requested = readOption('--mode') ?? 'all'
  if (requested === 'all') return ['headed-gpu', 'headless-software']
  if (requested === 'headed-gpu' || requested === 'headless-software') {
    return [requested]
  }
  throw new Error('--mode must be headed-gpu, headless-software, or all')
}

async function readGpuInfo(browser: Browser): Promise<HalftoneBenchmarkMode['gpu']> {
  try {
    const session = await browser.newBrowserCDPSession()
    const info = (await session.send('SystemInfo.getInfo')) as {
      gpu?: {
        devices?: Array<{
          vendorString?: string
          deviceString?: string
          driverVendor?: string
          driverVersion?: string
        }>
        featureStatus?: Record<string, string>
      }
    }
    await session.detach()
    return {
      devices: (info.gpu?.devices ?? []).map((device) => ({
        vendorString: device.vendorString ?? 'unknown',
        deviceString: device.deviceString ?? 'unknown',
        driverVendor: device.driverVendor ?? 'unknown',
        driverVersion: device.driverVersion ?? 'unknown',
      })),
      featureStatus: info.gpu?.featureStatus ?? {},
    }
  } catch {
    return { devices: [], featureStatus: {} }
  }
}

async function runMode(
  mode: BenchmarkModeName,
  warmupCount: number,
  sampleCount: number
): Promise<HalftoneBenchmarkMode> {
  const definition = modeDefinitions[mode]
  const browser = await chromium.launch({
    headless: definition.headless,
    args: definition.launchArgs,
  })

  try {
    const gpu = await readGpuInfo(browser)
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_PIXEL_RATIO,
    })
    const page = await context.newPage()
    await page.bringToFront()
    await page.setContent(
      '<main id="benchmark-root" style="display:grid;grid-template-columns:repeat(2,max-content);gap:8px"></main>'
    )
    // tsx preserves nested function names with this esbuild helper. Playwright
    // serializes the evaluate callback without its module-scope helper.
    await page.addScriptTag({
      content: 'globalThis.__name = (target) => target;',
    })

    const fixtures = await page.evaluate(
      async ({ card, bands, warmups, samples, dpr }) => {
        interface DotSet {
          x: Float32Array
          y: Float32Array
          radius: Float32Array
          alpha: Float32Array
          count: number
        }
        interface Variant {
          name: 'per-dot' | 'alpha-buckets'
          alphaBands: number | null
          contexts: CanvasRenderingContext2D[]
          band: Uint8Array | null
          sortedIndices: Uint32Array | null
          bandCounts: Uint32Array | null
          bandOffsets: Uint32Array | null
          bandWrites: Uint32Array | null
          durations: number[]
          draw: () => void
        }

        const root = document.querySelector('#benchmark-root')
        if (!root) throw new Error('Benchmark root is missing')
        const benchmarkRoot = root
        const tau = Math.PI * 2

        function flushRasterWork(variants: Variant[]): void {
          // A one-pixel readback periodically drains the Canvas2D command queue
          // outside the timed interval. Chromium orders the preceding canvas
          // work before this readback. Draining every 30 samples avoids an
          // unbounded backlog without making GPU readback part of every sample.
          const variant = variants[variants.length - 1]
          const context = variant.contexts[variant.contexts.length - 1]
          context.getImageData(0, 0, 1, 1)
        }

        function createDotSet(): DotSet {
          const capacity = card.columns * card.rows
          const x = new Float32Array(capacity)
          const y = new Float32Array(capacity)
          const radius = new Float32Array(capacity)
          const alpha = new Float32Array(capacity)
          const offsetX = (card.width - (card.columns - 1) * 6) / 2
          const offsetY = (card.height - (card.rows - 1) * 6) / 2
          let count = 0

          for (let row = 0; row < card.rows; row++) {
            for (let column = 0; column < card.columns; column++) {
              const cell = row * card.columns + column
              // Match the measured production fixture's approximately 4,326
              // visible dots while retaining a spatially uniform cull.
              if (cell < 4410 && cell % 49 === 0) continue
              const u = column / card.columns
              const v = row / card.rows
              const wave =
                0.5 +
                0.25 * Math.sin(u * 13 + v * 6) +
                0.25 * Math.sin(u * 4 + v * 11)
              const deltaX = (column - (card.columns - 1) / 2) / ((card.columns - 1) / 2)
              const deltaY = (row - (card.rows - 1) / 2) / ((card.rows - 1) / 2)
              const vignette = Math.max(
                0.5,
                1 - Math.max(0, Math.hypot(deltaX, deltaY) - 0.4) * 0.32
              )
              x[count] = offsetX + column * 6
              y[count] = offsetY + row * 6
              radius[count] = 0.35 + Math.max(0, wave) * 1.7 * vignette
              alpha[count] = Math.min(1, (0.2 + Math.max(0, wave) * 0.8) * vignette)
              count++
            }
          }

          return { x, y, radius, alpha, count }
        }

        function createContexts(cards: number): CanvasRenderingContext2D[] {
          const contexts: CanvasRenderingContext2D[] = []
          for (let cardIndex = 0; cardIndex < cards; cardIndex++) {
            const canvas = document.createElement('canvas')
            canvas.width = card.width * dpr
            canvas.height = card.height * dpr
            canvas.style.width = `${card.width}px`
            canvas.style.height = `${card.height}px`
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Canvas2D is unavailable')
            context.setTransform(dpr, 0, 0, dpr, 0, 0)
            context.fillStyle = '#111827'
            benchmarkRoot.appendChild(canvas)
            contexts.push(context)
          }
          return contexts
        }

        function createPerDotVariant(cards: number, dots: DotSet): Variant {
          const contexts = createContexts(cards)
          const variant: Variant = {
            name: 'per-dot',
            alphaBands: null,
            contexts,
            band: null,
            sortedIndices: null,
            bandCounts: null,
            bandOffsets: null,
            bandWrites: null,
            durations: [],
            draw: () => {
              for (let cardIndex = 0; cardIndex < contexts.length; cardIndex++) {
                const context = contexts[cardIndex]
                context.clearRect(0, 0, card.width, card.height)
                context.fillStyle = '#111827'
                for (let dot = 0; dot < dots.count; dot++) {
                  context.globalAlpha = dots.alpha[dot]
                  context.beginPath()
                  context.arc(dots.x[dot], dots.y[dot], dots.radius[dot], 0, tau)
                  context.fill()
                }
                context.globalAlpha = 1
              }
            },
          }
          return variant
        }

        function createBucketVariant(
          cards: number,
          dots: DotSet,
          alphaBands: number
        ): Variant {
          const contexts = createContexts(cards)
          const band = new Uint8Array(dots.count)
          const sortedIndices = new Uint32Array(dots.count)
          const bandCounts = new Uint32Array(alphaBands)
          const bandOffsets = new Uint32Array(alphaBands)
          const bandWrites = new Uint32Array(alphaBands)
          for (let dot = 0; dot < dots.count; dot++) {
            band[dot] = Math.min(
              alphaBands - 1,
              Math.floor(dots.alpha[dot] * alphaBands)
            )
          }

          const variant: Variant = {
            name: 'alpha-buckets',
            alphaBands,
            contexts,
            band,
            sortedIndices,
            bandCounts,
            bandOffsets,
            bandWrites,
            durations: [],
            draw: () => {
              bandCounts.fill(0)
              for (let dot = 0; dot < dots.count; dot++) {
                bandCounts[band[dot]]++
              }
              let offset = 0
              for (let alphaBand = 0; alphaBand < alphaBands; alphaBand++) {
                bandOffsets[alphaBand] = offset
                bandWrites[alphaBand] = offset
                offset += bandCounts[alphaBand]
              }
              for (let dot = 0; dot < dots.count; dot++) {
                const alphaBand = band[dot]
                sortedIndices[bandWrites[alphaBand]++] = dot
              }

              for (let cardIndex = 0; cardIndex < contexts.length; cardIndex++) {
                const context = contexts[cardIndex]
                context.clearRect(0, 0, card.width, card.height)
                context.fillStyle = '#111827'
                for (let alphaBand = 0; alphaBand < alphaBands; alphaBand++) {
                  const count = bandCounts[alphaBand]
                  if (count === 0) continue
                  context.globalAlpha = (alphaBand + 0.5) / alphaBands
                  context.beginPath()
                  const start = bandOffsets[alphaBand]
                  const end = start + count
                  for (let sorted = start; sorted < end; sorted++) {
                    const dot = sortedIndices[sorted]
                    context.moveTo(dots.x[dot] + dots.radius[dot], dots.y[dot])
                    context.arc(dots.x[dot], dots.y[dot], dots.radius[dot], 0, tau)
                  }
                  context.fill()
                }
                context.globalAlpha = 1
              }
            },
          }
          return variant
        }

        function percentile(sorted: number[], quantile: number): number {
          const index = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(sorted.length * quantile) - 1)
          )
          return sorted[index]
        }

        const dots = createDotSet()
        const fixtureDefinitions = [
          { name: 'one-wide-card' as const, cards: 1 },
          { name: 'eight-wide-card-board' as const, cards: 8 },
        ]
        const fixtureResults = []

        for (const fixture of fixtureDefinitions) {
          benchmarkRoot.replaceChildren()
          const variants = [
            createPerDotVariant(fixture.cards, dots),
            ...bands.map((alphaBands) =>
              createBucketVariant(fixture.cards, dots, alphaBands)
            ),
          ]

          for (let warmup = 0; warmup < warmups; warmup++) {
            for (let offset = 0; offset < variants.length; offset++) {
              variants[(warmup + offset) % variants.length].draw()
            }
            if ((warmup + 1) % 30 === 0 || warmup + 1 === warmups) {
              flushRasterWork(variants)
            }
          }

          for (let sample = 0; sample < samples; sample++) {
            for (let offset = 0; offset < variants.length; offset++) {
              const variant = variants[(sample + offset) % variants.length]
              const start = performance.now()
              variant.draw()
              variant.durations.push(performance.now() - start)
            }
            if ((sample + 1) % 30 === 0 || sample + 1 === samples) {
              flushRasterWork(variants)
            }
          }

          fixtureResults.push({
            name: fixture.name,
            cards: fixture.cards,
            cardWidth: card.width,
            cardHeight: card.height,
            columns: card.columns,
            rows: card.rows,
            dotsPerCard: dots.count,
            warmupCount: warmups,
            sampleCount: samples,
            strategies: variants.map((variant) => {
              const sorted = variant.durations.slice().sort((left, right) => left - right)
              return {
                name: variant.name,
                alphaBands: variant.alphaBands,
                medianMs: percentile(sorted, 0.5),
                p95Ms: percentile(sorted, 0.95),
                minimumMs: sorted[0],
                maximumMs: sorted[sorted.length - 1],
              }
            }),
          })
        }

        return fixtureResults
      },
      {
        card: WIDE_CARD,
        bands: CONFIRMATION_BANDS,
        warmups: warmupCount,
        samples: sampleCount,
        dpr: DEVICE_PIXEL_RATIO,
      }
    )

    await context.close()
    return {
      mode,
      headless: definition.headless,
      browserVersion: browser.version(),
      launchArgs: definition.launchArgs,
      gpu,
      fixtures: fixtures as HalftoneBenchmarkFixture[],
    }
  } finally {
    await browser.close()
  }
}

function strategy(
  fixture: HalftoneBenchmarkFixture,
  name: 'per-dot' | 'alpha-buckets',
  alphaBands: number | null
) {
  const found = fixture.strategies.find(
    (candidate) => candidate.name === name && candidate.alphaBands === alphaBands
  )
  if (!found) {
    throw new Error(`${fixture.name} is missing ${name} ${alphaBands ?? ''}`.trim())
  }
  return found
}

function buildGates(runs: HalftoneBenchmarkMode[]): HalftoneBenchmarkGate[] {
  const gates: HalftoneBenchmarkGate[] = []
  for (const run of runs) {
    const oneCard = run.fixtures.find((fixture) => fixture.cards === 1)
    const board = run.fixtures.find((fixture) => fixture.cards === 8)
    if (!oneCard || !board) throw new Error(`${run.mode} is missing a benchmark fixture`)
    const reference = strategy(oneCard, 'per-dot', null)
    const candidate = strategy(oneCard, 'alpha-buckets', 32)
    const boardCandidate = strategy(board, 'alpha-buckets', 32)
    const medianImprovement = 1 - candidate.medianMs / reference.medianMs
    const p95Improvement = 1 - candidate.p95Ms / reference.p95Ms

    if (run.mode === 'headed-gpu') {
      gates.push(
        {
          name: '32-band median per-card draw reduction',
          mode: run.mode,
          actual: medianImprovement,
          requirement: '>= 35%',
          passed: medianImprovement >= 0.35,
        },
        {
          name: '32-band p95 per-card draw reduction',
          mode: run.mode,
          actual: p95Improvement,
          requirement: '> 0%',
          passed: p95Improvement > 0,
        },
        {
          name: 'eight-card p95 main-thread draw time',
          mode: run.mode,
          actual: boardCandidate.p95Ms,
          requirement: '< 16.7ms',
          passed: boardCandidate.p95Ms < 16.7,
        }
      )
    } else {
      const medianRatio = candidate.medianMs / reference.medianMs
      const p95Ratio = candidate.p95Ms / reference.p95Ms
      gates.push(
        {
          name: 'software median regression',
          mode: run.mode,
          actual: medianRatio - 1,
          requirement: '<= 10%',
          passed: medianRatio <= 1.1,
        },
        {
          name: 'software p95 regression',
          mode: run.mode,
          actual: p95Ratio - 1,
          requirement: '<= 10%',
          passed: p95Ratio <= 1.1,
        }
      )
    }
  }
  return gates
}

function printSummary(runs: HalftoneBenchmarkMode[], gates: HalftoneBenchmarkGate[]): void {
  console.log('\nHalftone Canvas2D benchmark')
  for (const run of runs) {
    console.log(`\n${run.mode} · Chromium ${run.browserVersion}`)
    for (const fixture of run.fixtures) {
      console.log(
        `${fixture.name}: ${fixture.cardWidth}×${fixture.cardHeight}, ` +
          `${fixture.dotsPerCard.toLocaleString()} dots/card, ` +
          `${fixture.sampleCount} samples after ${fixture.warmupCount} warmups`
      )
      for (const result of fixture.strategies) {
        const label =
          result.name === 'per-dot'
            ? 'per-dot'
            : `${result.alphaBands}-band`
        console.log(
          `  ${label.padEnd(8)} median ${result.medianMs.toFixed(3)}ms · ` +
            `p95 ${result.p95Ms.toFixed(3)}ms`
        )
      }
    }
  }

  console.log('\nDecision gates')
  for (const gate of gates) {
    const unit = gate.name.includes('time') ? 'ms' : '%'
    const actual =
      unit === 'ms'
        ? `${gate.actual.toFixed(3)}ms`
        : `${(gate.actual * 100).toFixed(1)}%`
    console.log(
      `  ${gate.passed ? 'PASS' : 'FAIL'} ${gate.mode}: ${gate.name} ` +
        `${actual} (${gate.requirement})`
    )
  }
}

async function main(): Promise<void> {
  const warmupCount = readCount('--warmups', DEFAULT_WARMUP_COUNT)
  const sampleCount = readCount('--samples', DEFAULT_SAMPLE_COUNT)
  if (sampleCount === 0) throw new Error('--samples must be greater than zero')

  const runs: HalftoneBenchmarkMode[] = []
  for (const mode of requestedModes()) {
    runs.push(await runMode(mode, warmupCount, sampleCount))
  }
  const gates = buildGates(runs)
  const cpuInfo = os.cpus()
  const result = halftoneBenchmarkResultSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpu: cpuInfo[0]?.model ?? 'unknown',
      logicalCpuCount: cpuInfo.length,
      viewportWidth: VIEWPORT.width,
      viewportHeight: VIEWPORT.height,
      devicePixelRatio: DEVICE_PIXEL_RATIO,
    },
    config: {
      warmupCount,
      sampleCount,
      alphaBands: CONFIRMATION_BANDS,
    },
    runs,
    gates,
    passed: gates.every((gate) => gate.passed),
  })

  const requestedOutput = readOption('--output')
  const timestamp = result.generatedAt.replaceAll(':', '-')
  const outputPath = path.resolve(
    requestedOutput ??
      path.join('test-results', 'halftone-benchmark', `halftone-${timestamp}.json`)
  )
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)

  printSummary(result.runs, result.gates)
  console.log(`\nMachine-readable results: ${outputPath}`)
  if (!result.passed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
