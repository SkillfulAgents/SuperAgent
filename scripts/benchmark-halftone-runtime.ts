import { chromium, type Browser } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build as viteBuild } from 'vite'
import {
  halftoneRuntimeBenchmarkResultSchema,
  type HalftoneRuntimeBenchmarkFixture,
  type HalftoneRuntimeBenchmarkMode,
} from './halftone-runtime-benchmark-schema'

type BenchmarkModeName = 'headed-gpu' | 'headless-software'

const CARD = { width: 576, height: 276 }
const VIEWPORT = { width: 1440, height: 1100 }
const DEVICE_PIXEL_RATIO = 2
const DEFAULT_WARMUP_COUNT = 60
const DEFAULT_SAMPLE_COUNT = 180

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

async function bundleRenderer(): Promise<string> {
  const output = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2020',
      lib: {
        entry: path.resolve('src/renderer/components/agents/halftone-renderer.ts'),
        formats: ['iife'],
        name: 'HalftoneRuntime',
      },
    },
  })
  const results = (Array.isArray(output) ? output : [output]) as Array<{
    output: Array<{ type: string; code?: string; isEntry?: boolean }>
  }>
  for (const result of results) {
    const entry = result.output.find(
      (artifact) => artifact.type === 'chunk' && artifact.isEntry
    )
    if (entry?.code) return entry.code
  }
  throw new Error('Vite did not emit the Halftone renderer benchmark bundle')
}

async function readGpuInfo(
  browser: Browser
): Promise<HalftoneRuntimeBenchmarkMode['gpu']> {
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
  rendererBundle: string,
  warmupCount: number,
  sampleCount: number
): Promise<HalftoneRuntimeBenchmarkMode> {
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
    await page.addScriptTag({ content: rendererBundle })
    // tsx preserves nested function names with this esbuild helper. Playwright
    // serializes the evaluate callback without its module-scope helper.
    await page.addScriptTag({
      content: 'globalThis.__name = (target) => target;',
    })

    const fixtures = await page.evaluate(
      async ({ card, warmups, samples, dpr }) => {
        interface Renderer {
          readonly columnCount: number
          readonly rowCount: number
          readonly capacity: number
          resize: (width: number, height: number) => boolean
          draw: (
            context: CanvasRenderingContext2D,
            time: number,
            strategy: 'alpha-buckets',
            pointerX: number,
            pointerY: number,
            pointerActive: boolean
          ) => number
        }
        interface RendererConstructor {
          new (options: {
            motif: 'flow_3d' | 'pulse'
            state: 'working' | 'alert'
            color: string
            spacing?: number
            maxRadius?: number
            vignette?: number
            contrast?: number
            seed?: number
          }): Renderer
        }
        interface FixtureDefinition {
          name:
            | 'flow-one-card-inactive'
            | 'flow-eight-card-board-inactive'
            | 'flow-eight-card-board-one-pointer'
            | 'pulse-one-card-inactive'
            | 'pulse-eight-card-board-inactive'
          motif: 'flow_3d' | 'pulse'
          cards: number
          pointerCards: number
          speed: number
        }
        interface RuntimeCard {
          context: CanvasRenderingContext2D
          renderer: Renderer
        }

        const runtime = (
          globalThis as typeof globalThis & {
            HalftoneRuntime?: {
              HalftoneFrameRenderer?: RendererConstructor
            }
          }
        ).HalftoneRuntime
        const RendererClass = runtime?.HalftoneFrameRenderer
        if (!RendererClass) throw new Error('Bundled Halftone renderer is unavailable')
        const ProductionRenderer: RendererConstructor = RendererClass
        const root = document.querySelector('#benchmark-root')
        if (!root) throw new Error('Benchmark root is missing')
        const benchmarkRoot = root

        function percentile(sorted: number[], quantile: number): number {
          const index = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(sorted.length * quantile) - 1)
          )
          return sorted[index]
        }

        function createCards(definition: FixtureDefinition): RuntimeCard[] {
          const cards: RuntimeCard[] = []
          for (let cardIndex = 0; cardIndex < definition.cards; cardIndex++) {
            const canvas = document.createElement('canvas')
            canvas.width = card.width * dpr
            canvas.height = card.height * dpr
            canvas.style.width = `${card.width}px`
            canvas.style.height = `${card.height}px`
            const context = canvas.getContext('2d')
            if (!context) throw new Error('Canvas2D is unavailable')
            context.setTransform(dpr, 0, 0, dpr, 0, 0)
            const renderer =
              definition.motif === 'pulse'
                ? new ProductionRenderer({
                    motif: 'pulse',
                    state: 'alert',
                    color: '#f97316',
                    spacing: 5,
                    maxRadius: 1.3,
                    vignette: 0.4,
                    contrast: 1.6,
                    seed: cardIndex * 97,
                  })
                : new ProductionRenderer({
                    motif: 'flow_3d',
                    state: 'working',
                    color: '#111827',
                    spacing: 6,
                    maxRadius: 1.6,
                    vignette: 0.22,
                    contrast: 1.6,
                    seed: cardIndex * 97,
                  })
            renderer.resize(card.width, card.height)
            benchmarkRoot.appendChild(canvas)
            cards.push({ context, renderer })
          }
          return cards
        }

        function flushRasterWork(cards: RuntimeCard[]): void {
          cards[cards.length - 1].context.getImageData(0, 0, 1, 1)
        }

        const definitions: FixtureDefinition[] = [
          {
            name: 'flow-one-card-inactive',
            motif: 'flow_3d',
            cards: 1,
            pointerCards: 0,
            speed: 0.75,
          },
          {
            name: 'flow-eight-card-board-inactive',
            motif: 'flow_3d',
            cards: 8,
            pointerCards: 0,
            speed: 0.75,
          },
          {
            name: 'flow-eight-card-board-one-pointer',
            motif: 'flow_3d',
            cards: 8,
            pointerCards: 1,
            speed: 0.75,
          },
          {
            name: 'pulse-one-card-inactive',
            motif: 'pulse',
            cards: 1,
            pointerCards: 0,
            speed: 1.6,
          },
          {
            name: 'pulse-eight-card-board-inactive',
            motif: 'pulse',
            cards: 8,
            pointerCards: 0,
            speed: 1.6,
          },
        ]
        const fixtureResults = []

        for (const definition of definitions) {
          benchmarkRoot.replaceChildren()
          const cards = createCards(definition)
          const durations: number[] = []
          let time = 0
          let dotsPerCard = 0

          const draw = () => {
            let totalDots = 0
            for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
              const runtimeCard = cards[cardIndex]
              totalDots += runtimeCard.renderer.draw(
                runtimeCard.context,
                time,
                'alpha-buckets',
                card.width / 2,
                card.height / 2,
                cardIndex < definition.pointerCards
              )
            }
            dotsPerCard = Math.round(totalDots / cards.length)
            time += definition.speed
          }

          for (let warmup = 0; warmup < warmups; warmup++) {
            draw()
            if ((warmup + 1) % 30 === 0 || warmup + 1 === warmups) {
              flushRasterWork(cards)
            }
          }
          for (let sample = 0; sample < samples; sample++) {
            const start = performance.now()
            draw()
            durations.push(performance.now() - start)
            if ((sample + 1) % 30 === 0 || sample + 1 === samples) {
              flushRasterWork(cards)
            }
          }

          const sorted = durations.slice().sort((left, right) => left - right)
          fixtureResults.push({
            name: definition.name,
            motif: definition.motif,
            cards: definition.cards,
            pointerCards: definition.pointerCards,
            cardWidth: card.width,
            cardHeight: card.height,
            columns: cards[0].renderer.columnCount,
            rows: cards[0].renderer.rowCount,
            dotsPerCard,
            warmupCount: warmups,
            sampleCount: samples,
            medianMs: percentile(sorted, 0.5),
            p95Ms: percentile(sorted, 0.95),
            minimumMs: sorted[0],
            maximumMs: sorted[sorted.length - 1],
          })
        }

        benchmarkRoot.replaceChildren()
        const resizeRenderer = new ProductionRenderer({
          motif: 'flow_3d',
          state: 'working',
          color: '#111827',
          spacing: 6,
          maxRadius: 1.6,
          vignette: 0.22,
          contrast: 1.6,
          seed: 0,
        })
        resizeRenderer.resize(card.width, card.height)
        for (let warmup = 0; warmup < warmups; warmup++) {
          resizeRenderer.resize(card.width, card.height)
        }
        const resizeDurations: number[] = []
        let capacityCheck = 0
        for (let sample = 0; sample < samples; sample++) {
          const start = performance.now()
          resizeRenderer.resize(card.width, card.height)
          resizeDurations.push(performance.now() - start)
          capacityCheck += resizeRenderer.capacity
        }
        if (capacityCheck === 0) throw new Error('Resize benchmark was optimized away')
        const sortedResizeDurations = resizeDurations
          .slice()
          .sort((left, right) => left - right)

        const pointerIterations = 20_000
        const pointerTrials = 7
        const pointerVariants = []
        for (const listenerCount of [1, 8]) {
          const trialDurations: number[] = []
          for (let trial = 0; trial < pointerTrials; trial++) {
            let observedX = 0
            let observedY = 0
            const listeners = Array.from({ length: listenerCount }, () => {
              const listener = (event: PointerEvent) => {
                observedX = event.clientX
                observedY = event.clientY
              }
              window.addEventListener('pointermove', listener, { passive: true })
              return listener
            })
            const event = new PointerEvent('pointermove', {
              clientX: trial + 1,
              clientY: trial + 2,
            })
            for (let warmup = 0; warmup < 1_000; warmup++) {
              window.dispatchEvent(event)
            }
            const start = performance.now()
            for (let iteration = 0; iteration < pointerIterations; iteration++) {
              window.dispatchEvent(event)
            }
            trialDurations.push(
              ((performance.now() - start) * 1_000) / pointerIterations
            )
            for (const listener of listeners) {
              window.removeEventListener('pointermove', listener)
            }
            if (observedX === 0 || observedY === 0) {
              throw new Error('Pointer dispatch benchmark did not invoke listeners')
            }
          }
          const sortedTrials = trialDurations
            .slice()
            .sort((left, right) => left - right)
          pointerVariants.push({
            listenerCount,
            medianMicrosecondsPerEvent: percentile(sortedTrials, 0.5),
            p95MicrosecondsPerEvent: percentile(sortedTrials, 0.95),
          })
        }

        return {
          fixtures: fixtureResults,
          sameSizeResize: {
            warmupCount: warmups,
            sampleCount: samples,
            medianMs: percentile(sortedResizeDurations, 0.5),
            p95Ms: percentile(sortedResizeDurations, 0.95),
            minimumMs: sortedResizeDurations[0],
            maximumMs: sortedResizeDurations[sortedResizeDurations.length - 1],
          },
          pointerDispatch: {
            iterationsPerTrial: pointerIterations,
            trials: pointerTrials,
            variants: pointerVariants,
          },
        }
      },
      {
        card: CARD,
        warmups: warmupCount,
        samples: sampleCount,
        dpr: DEVICE_PIXEL_RATIO,
      }
    )

    await context.close()
    const measured = fixtures as {
      fixtures: HalftoneRuntimeBenchmarkFixture[]
      sameSizeResize: HalftoneRuntimeBenchmarkMode['sameSizeResize']
      pointerDispatch: HalftoneRuntimeBenchmarkMode['pointerDispatch']
    }
    return {
      mode,
      headless: definition.headless,
      browserVersion: browser.version(),
      launchArgs: definition.launchArgs,
      gpu,
      fixtures: measured.fixtures,
      sameSizeResize: measured.sameSizeResize,
      pointerDispatch: measured.pointerDispatch,
    }
  } finally {
    await browser.close()
  }
}

function printSummary(runs: HalftoneRuntimeBenchmarkMode[]): void {
  console.log('\nHalftone full-renderer benchmark')
  for (const run of runs) {
    console.log(`\n${run.mode} · Chromium ${run.browserVersion}`)
    for (const fixture of run.fixtures) {
      console.log(
        `${fixture.name}: ${fixture.cards} card${fixture.cards === 1 ? '' : 's'}, ` +
          `${fixture.dotsPerCard.toLocaleString()} dots/card · ` +
          `median ${fixture.medianMs.toFixed(3)}ms · p95 ${fixture.p95Ms.toFixed(3)}ms`
      )
    }
    console.log(
      `same-size resize: median ${run.sameSizeResize.medianMs.toFixed(3)}ms · ` +
        `p95 ${run.sameSizeResize.p95Ms.toFixed(3)}ms`
    )
    console.log(
      `pointer dispatch: ${run.pointerDispatch.variants
        .map(
          (variant) =>
            `${variant.listenerCount} listener${variant.listenerCount === 1 ? '' : 's'} ` +
            `${variant.medianMicrosecondsPerEvent.toFixed(3)}µs/event`
        )
        .join(' · ')}`
    )
  }
}

async function main(): Promise<void> {
  const warmupCount = readCount('--warmups', DEFAULT_WARMUP_COUNT)
  const sampleCount = readCount('--samples', DEFAULT_SAMPLE_COUNT)
  if (sampleCount === 0) throw new Error('--samples must be greater than zero')
  const label = readOption('--label') ?? 'working-tree'
  const rendererBundle = await bundleRenderer()
  const runs: HalftoneRuntimeBenchmarkMode[] = []
  for (const mode of requestedModes()) {
    runs.push(await runMode(mode, rendererBundle, warmupCount, sampleCount))
  }
  const cpuInfo = os.cpus()
  const sourceRevision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const result = halftoneRuntimeBenchmarkResultSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    label,
    sourceRevision,
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
    },
    runs,
  })

  const requestedOutput = readOption('--output')
  const timestamp = result.generatedAt.replaceAll(':', '-')
  const outputPath = path.resolve(
    requestedOutput ??
      path.join(
        'test-results',
        'halftone-runtime-benchmark',
        `halftone-runtime-${timestamp}.json`
      )
  )
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)

  printSummary(result.runs)
  console.log(`\nMachine-readable results: ${outputPath}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
