/**
 * Compare the working tree with an existing stack revision, without checking
 * out another branch or running the app build. Example:
 * E2E_MOCK=true npx tsx scripts/benchmark-agent-avatars.ts --baseline <sha> 2>&1 | tee /tmp/avatar-perf.txt
 */
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AvatarFixture } from '../perf/agent-avatar-fixture'
import { avatarBenchmarkReportSchema, avatarBenchmarkSampleSchema, type AvatarBenchmarkSample } from './agent-avatar-benchmark-schema'

const root = process.cwd()
const option = (name: string) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const count = (name: string, fallback: number) => {
  const value = Number(option(name) ?? fallback)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const baseline = git('rev-parse', '--verify', option('--baseline') ?? 'HEAD')
const sampleMs = count('--sample-ms', 1500)
const warmupMs = count('--warmup-ms', 2000)
const trials = count('--trials', 3)

const fixtures: AvatarFixture[] = [
  { name: '40 idle / no pointer', count: 40, state: 'idle', pointer: 'none', layout: 'sidebar' },
  { name: '40 idle / stationary pointer', count: 40, state: 'idle', pointer: 'stationary', layout: 'sidebar' },
  { name: '40 idle / moving pointer', count: 40, state: 'idle', pointer: 'moving', layout: 'sidebar' },
  { name: '200 idle / moving pointer', count: 200, state: 'idle', pointer: 'moving', layout: 'sidebar' },
  { name: '200 idle / offscreen sidebar', count: 200, state: 'idle', pointer: 'none', layout: 'sidebar', offscreen: true },
  { name: '40 working / no pointer', count: 40, state: 'working', pointer: 'none', layout: 'sidebar' },
  { name: '200 working / offscreen sidebar', count: 200, state: 'working', pointer: 'none', layout: 'sidebar', offscreen: true },
  { name: '28-option picker / moving pointer', count: 28, state: 'idle', pointer: 'moving', layout: 'picker' },
]

async function bundle(ref?: string) {
  const output = await build({
    entryPoints: [path.join(root, 'perf/agent-avatar-fixture.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    tsconfig: path.join(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: ref ? [{
      name: 'avatar-at-revision',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]components[/\\]agents[/\\]agent-avatar[/\\].*\.tsx?$/ }, args => ({
          contents: git('show', `${ref}:${path.relative(root, args.path).split(path.sep).join('/')}`),
          loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
          resolveDir: path.dirname(args.path),
        }))
      },
    }] : [],
  })
  return output.outputFiles[0].text
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function main() {
  const [before, after] = await Promise.all([bundle(baseline), bundle()])
  const browser = await chromium.launch({ headless: true })
  const samples: AvatarBenchmarkSample[] = []
  try {
    for (const fixture of fixtures) {
      for (let trial = 1; trial <= trials; trial++) {
        // Alternate order to reduce systematic warm-up/order bias.
        const variants = trial % 2 ? ['baseline', 'working-tree'] as const : ['working-tree', 'baseline'] as const
        for (const variant of variants) {
          const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
          try {
            await page.setContent(`<style>
              body { margin: 0; }
              .relative { position: relative; } .block { display: block; } .shrink-0 { flex-shrink: 0; }
              .absolute { position: absolute; } .inset-0 { inset: 0; } .overflow-hidden { overflow: hidden; }
              .rounded-full { border-radius: 9999px; }
            </style><div id="root"></div>`)
            await page.addScriptTag({ content: variant === 'baseline' ? before : after })
            await page.evaluate(value => window.agentAvatarBenchmark.mount(value), fixture)
            // Allow initial intersection callbacks before sending the stationary pointer event.
            await page.waitForTimeout(200)
            await page.evaluate(value => window.agentAvatarBenchmark.pointer(value), fixture.pointer)
            await page.waitForTimeout(warmupMs)
            const cdp = await page.context().newCDPSession(page)
            await cdp.send('Performance.enable')
            const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
            await page.evaluate(() => window.agentAvatarBenchmark.reset())
            const start = await metrics()
            await page.waitForTimeout(sampleMs)
            const end = await metrics()
            const counters = await page.evaluate(() => window.agentAvatarBenchmark.counters())
            const sample = avatarBenchmarkSampleSchema.parse({
              variant, fixture: fixture.name, trial,
              elapsedMs: (end.Timestamp - start.Timestamp) * 1000,
              taskMs: (end.TaskDuration - start.TaskDuration) * 1000,
              scriptMs: (end.ScriptDuration - start.ScriptDuration) * 1000,
              layoutCount: end.LayoutCount - start.LayoutCount,
              styleCount: end.RecalcStyleCount - start.RecalcStyleCount,
              ...counters,
            })
            samples.push(sample)
            console.log(`${fixture.name}; ${variant}; trial ${trial}: ${(sample.taskMs / sample.elapsedMs * 100).toFixed(1)}% main-thread time, ${sample.rectReads} bounds reads, ${sample.layoutCount} layouts`)
          } finally {
            await page.close()
          }
        }
      }
    }
    const report = avatarBenchmarkReportSchema.parse({
      generatedAt: new Date().toISOString(), baseline, workingTreeHead: git('rev-parse', 'HEAD'),
      browser: browser.version(), cpu: os.cpus()[0].model, platform: `${os.platform()} ${os.arch()}`,
      mode: 'headless Chromium component fixture; production React; DPR 2',
      sampleMs, warmupMs, samples,
    })
    writeFileSync(option('--output') ?? '/tmp/agent-avatar-performance.json', JSON.stringify(report, null, 2))
    console.table(fixtures.map(fixture => {
      const forVariant = (variant: AvatarBenchmarkSample['variant']) => samples.filter(s => s.fixture === fixture.name && s.variant === variant)
      const beforeMs = median(forVariant('baseline').map(s => s.taskMs / s.elapsedMs * 1000))
      const afterMs = median(forVariant('working-tree').map(s => s.taskMs / s.elapsedMs * 1000))
      return {
        fixture: fixture.name, 'before ms/s': beforeMs.toFixed(1), 'after ms/s': afterMs.toFixed(1),
        reduction: `${((1 - afterMs / beforeMs) * 100).toFixed(1)}%`,
        'after bounds reads': median(forVariant('working-tree').map(s => s.rectReads)),
        'after layouts': median(forVariant('working-tree').map(s => s.layoutCount)),
      }
    }))
  } finally {
    await browser.close()
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
