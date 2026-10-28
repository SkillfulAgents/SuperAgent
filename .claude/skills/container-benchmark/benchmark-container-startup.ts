#!/usr/bin/env npx tsx
/**
 * Container startup benchmark & validation script.
 *
 * Exercises the REAL code path through a running dev server:
 *   container start → dashboard boot → proxy serve → agentic message → stop
 *
 * Usage:
 *   npx tsx scripts/benchmark-container-startup.ts [options]
 *
 * Prerequisites:
 *   - Dev server running (npm run dev)
 *   - Container runtime (Docker/Lima/Podman) available
 *   - Agent container image built
 */

import * as fs from 'fs'
import * as path from 'path'
import { EventSource } from 'eventsource'
import { performance } from 'perf_hooks'

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface Config {
  runs: number
  baseUrl: string
  timeoutMs: number
  jsonOut: string | null
  skipSession: boolean
  keepAgent: boolean
}

function parseArgs(): Config {
  const args = process.argv.slice(2)
  const config: Config = {
    runs: 3,
    baseUrl: 'http://localhost:47891',
    timeoutMs: 120_000,
    jsonOut: null,
    skipSession: false,
    keepAgent: false,
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--runs':
        config.runs = parseInt(args[++i], 10)
        if (isNaN(config.runs) || config.runs < 1) {
          console.error('--runs must be a positive integer')
          process.exit(1)
        }
        break
      case '--base-url':
        config.baseUrl = args[++i]
        break
      case '--timeout':
        config.timeoutMs = parseInt(args[++i], 10)
        break
      case '--json-out':
        config.jsonOut = args[++i]
        break
      case '--skip-session':
        config.skipSession = true
        break
      case '--keep-agent':
        config.keepAgent = true
        break
      case '--help':
        console.log(`Usage: npx tsx scripts/benchmark-container-startup.ts [options]

Options:
  --runs N           Number of start/stop cycles (default: 3)
  --base-url URL     Dev server URL (default: http://localhost:47891)
  --timeout MS       Max wait per phase in ms (default: 120000)
  --json-out PATH    Write results JSON to file
  --skip-session     Skip session/message test (saves LLM cost)
  --keep-agent       Don't delete agent on exit (for debugging)`)
        process.exit(0)
        break
      default:
        console.error(`Unknown argument: ${args[i]}`)
        process.exit(1)
    }
  }

  return config
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiResult<T> {
  ok: boolean
  status: number
  data: T
  durationMs: number
  error?: string
}

interface SseEvent {
  type: string
  agentSlug?: string
  status?: string
  receivedAt: number
}

interface Timings {
  containerStartMs: number
  dashboardStartMs: number
  dashboardFirstServeMs: number
  totalStartToHtmlMs: number
  stopMs: number
  sessionCreateMs: number | null
  messageProcessMs: number | null
}

interface Validations {
  containerStarted: boolean
  dashboardRunning: boolean
  dashboardServesHtml: boolean
  dashboardHasMarker: boolean
  polyfillsInjected: boolean
  sseStartEventFired: boolean
  stopWorked: boolean
  sseStopEventFired: boolean
  sessionCreated: boolean | null
  messageReceived: boolean | null
}

interface CycleResult {
  run: number
  success: boolean
  errors: string[]
  timings: Timings
  validations: Validations
}

interface Stats {
  p50: number
  p95: number
  mean: number
  min: number
  max: number
}

interface BenchmarkSummary {
  timestamp: string
  config: Config
  runs: CycleResult[]
  summary: Record<string, Stats>
  validationsPassed: number
  validationsTotal: number
  allPassed: boolean
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatMs(ms: number): string {
  return `${ms.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}ms`
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function computeStats(values: number[]): Stats {
  if (values.length === 0) return { p50: 0, p95: 0, mean: 0, min: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

class ApiClient {
  constructor(private baseUrl: string) {}

  private async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    expectJson = true
  ): Promise<ApiResult<T>> {
    const url = `${this.baseUrl}${urlPath}`
    const t0 = performance.now()
    try {
      const init: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      }
      if (body !== undefined) {
        init.body = JSON.stringify(body)
      }
      const res = await fetch(url, init)
      const durationMs = performance.now() - t0

      if (!res.ok) {
        let errorText: string
        try {
          const errBody = await res.json() as { error?: string }
          errorText = errBody.error || res.statusText
        } catch {
          errorText = res.statusText
        }
        return { ok: false, status: res.status, data: undefined as T, durationMs, error: errorText }
      }

      let data: T
      if (res.status === 204) {
        data = undefined as T
      } else if (expectJson) {
        data = await res.json() as T
      } else {
        data = await res.text() as T
      }
      return { ok: true, status: res.status, data, durationMs }
    } catch (err: any) {
      const durationMs = performance.now() - t0
      return { ok: false, status: 0, data: undefined as T, durationMs, error: err.message }
    }
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.request('GET', '/api/agents')
    return result.ok
  }

  async getDataDir(): Promise<string | null> {
    const result = await this.request<{ dataDir: string }>('GET', '/api/settings')
    return result.ok ? result.data.dataDir : null
  }

  async createAgent(name: string, description: string) {
    return this.request<{ slug: string; name: string; status: string }>(
      'POST', '/api/agents', { name, description }
    )
  }

  async getAgent(slug: string) {
    return this.request<{ slug: string; status: string; containerPort: number | null }>(
      'GET', `/api/agents/${slug}`
    )
  }

  async startAgent(slug: string) {
    return this.request<{ slug: string; status: string; containerPort: number | null }>(
      'POST', `/api/agents/${slug}/start`
    )
  }

  async stopAgent(slug: string) {
    return this.request<{ slug: string; status: string }>(
      'POST', `/api/agents/${slug}/stop`
    )
  }

  async deleteAgent(slug: string) {
    return this.request<void>('DELETE', `/api/agents/${slug}`)
  }

  async listArtifacts(slug: string) {
    return this.request<Array<{ slug: string; status: string; port: number }>>(
      'GET', `/api/agents/${slug}/artifacts`
    )
  }

  async fetchDashboardHtml(slug: string, dashboardSlug: string) {
    return this.request<string>(
      'GET', `/api/agents/${slug}/artifacts/${dashboardSlug}/`, undefined, false
    )
  }

  async createSession(slug: string, message: string) {
    return this.request<{ id: string }>(
      'POST', `/api/agents/${slug}/sessions`, { message }
    )
  }

  async getMessages(slug: string, sessionId: string) {
    return this.request<Array<{ id: string; type: string; content?: { text: string } }>>(
      'GET', `/api/agents/${slug}/sessions/${sessionId}/messages`
    )
  }
}

// ---------------------------------------------------------------------------
// SseListener
// ---------------------------------------------------------------------------

class SseListener {
  private events: SseEvent[] = []
  private eventSource: EventSource | null = null
  private waiters: Array<{
    predicate: (e: SseEvent) => boolean
    resolve: (e: SseEvent) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  constructor(baseUrl: string) {
    const url = `${baseUrl}/api/notifications/stream`
    this.eventSource = new EventSource(url)

    this.eventSource.addEventListener('message', (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === 'ping') return

        const event: SseEvent = {
          type: data.type,
          agentSlug: data.agentSlug,
          status: data.status,
          receivedAt: performance.now(),
        }
        this.events.push(event)

        // Check waiters
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].predicate(event)) {
            clearTimeout(this.waiters[i].timer)
            this.waiters[i].resolve(event)
            this.waiters.splice(i, 1)
          }
        }
      } catch {
        // Ignore parse errors
      }
    })
  }

  async waitForConnection(timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('SSE connection timed out'))
      }, timeoutMs)

      if (this.eventSource!.readyState === EventSource.OPEN) {
        clearTimeout(timer)
        resolve()
        return
      }

      this.eventSource!.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })

      this.eventSource!.addEventListener('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`SSE connection error: ${err}`))
      }, { once: true })
    })
  }

  getEvents(): SseEvent[] {
    return [...this.events]
  }

  clearEvents(): void {
    this.events = []
  }

  waitForEvent(
    predicate: (e: SseEvent) => boolean,
    timeoutMs: number
  ): Promise<SseEvent> {
    // Check already-received events first
    const existing = this.events.find(predicate)
    if (existing) return Promise.resolve(existing)

    return new Promise<SseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error('SSE event wait timed out'))
      }, timeoutMs)

      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  close(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.reject(new Error('SSE listener closed'))
    }
    this.waiters = []
  }
}

// ---------------------------------------------------------------------------
// Filesystem seeder
// ---------------------------------------------------------------------------

async function seedDashboard(dataDir: string, agentSlug: string, dashboardSlug: string): Promise<void> {
  const artifactDir = path.join(dataDir, 'agents', agentSlug, 'workspace', 'artifacts', dashboardSlug)
  await fs.promises.mkdir(artifactDir, { recursive: true })

  await fs.promises.writeFile(
    path.join(artifactDir, 'package.json'),
    JSON.stringify(
      {
        name: 'bench-dashboard',
        description: 'Benchmark validation dashboard',
        scripts: { start: 'bun run index.js' },
        dependencies: {},
      },
      null,
      2
    )
  )

  const indexJs = `const port = process.env.DASHBOARD_PORT || process.env.PORT || 3000;
Bun.serve({
  port,
  fetch(req) {
    return new Response(\`<!DOCTYPE html>
<html><head><title>Bench</title></head>
<body><div id="bench-marker">OK</div><p>Benchmark dashboard running.</p></body>
</html>\`, { headers: { 'Content-Type': 'text/html' } });
  },
});
console.log('Benchmark dashboard running on port ' + port);
`
  await fs.promises.writeFile(path.join(artifactDir, 'index.js'), indexJs)
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

function emptyTimings(): Timings {
  return {
    containerStartMs: 0,
    dashboardStartMs: 0,
    dashboardFirstServeMs: 0,
    totalStartToHtmlMs: 0,
    stopMs: 0,
    sessionCreateMs: null,
    messageProcessMs: null,
  }
}

function emptyValidations(): Validations {
  return {
    containerStarted: false,
    dashboardRunning: false,
    dashboardServesHtml: false,
    dashboardHasMarker: false,
    polyfillsInjected: false,
    sseStartEventFired: false,
    stopWorked: false,
    sseStopEventFired: false,
    sessionCreated: null,
    messageReceived: null,
  }
}

async function runCycle(
  api: ApiClient,
  agentSlug: string,
  dashboardSlug: string,
  sse: SseListener,
  config: Config,
  runIndex: number
): Promise<CycleResult> {
  const result: CycleResult = {
    run: runIndex,
    success: false,
    errors: [],
    timings: emptyTimings(),
    validations: emptyValidations(),
  }

  // ── Pre-start: Ensure container is fully stopped ───────────────
  // Guard against stale state from a previous cycle's stop failing or
  // being slow. If the container is still running, stop it and poll
  // until the agent reports 'stopped' before we begin timing.
  const preCheck = await api.getAgent(agentSlug)
  if (preCheck.ok && preCheck.data.status === 'running') {
    console.log('    (container still running from previous cycle — stopping first)')
    await api.stopAgent(agentSlug)
    const preStopStart = performance.now()
    while (performance.now() - preStopStart < 30_000) {
      const check = await api.getAgent(agentSlug)
      if (check.ok && check.data.status === 'stopped') break
      await sleep(500)
    }
    // Verify it actually stopped
    const finalCheck = await api.getAgent(agentSlug)
    if (finalCheck.ok && finalCheck.data.status !== 'stopped') {
      result.errors.push(`Pre-start: container refused to stop (status: ${finalCheck.data.status})`)
      return finish(result)
    }
  }

  // ── Phase 1: Start container ──────────────────────────────────
  sse.clearEvents()
  const tGlobalStart = performance.now()

  const startResult = await api.startAgent(agentSlug)
  result.timings.containerStartMs = startResult.durationMs

  if (!startResult.ok) {
    result.errors.push(`Container start failed (HTTP ${startResult.status}): ${startResult.error}`)
    return finish(result)
  }

  result.validations.containerStarted = startResult.data.status === 'running'
  if (!result.validations.containerStarted) {
    result.errors.push(`Container status after start: ${startResult.data.status} (expected running)`)
  }

  // ── Phase 2: Wait for dashboard to become running ─────────────
  const dashPollStart = performance.now()
  let dashboardRunning = false
  let lastDashboardStatus = 'unknown'

  while (performance.now() - dashPollStart < config.timeoutMs) {
    const artifacts = await api.listArtifacts(agentSlug)
    if (artifacts.ok) {
      const dash = artifacts.data.find((a) => a.slug === dashboardSlug)
      if (dash) {
        lastDashboardStatus = dash.status
        if (dash.status === 'running') {
          dashboardRunning = true
          break
        }
        if (dash.status === 'crashed') {
          result.errors.push('Dashboard crashed during startup')
          break
        }
      }
    }
    await sleep(500)
  }

  result.timings.dashboardStartMs = performance.now() - dashPollStart
  result.validations.dashboardRunning = dashboardRunning

  if (!dashboardRunning) {
    result.errors.push(`Dashboard did not reach running state (last status: ${lastDashboardStatus})`)
    // Still try to proceed to stop phase
    await doStop(api, agentSlug, sse, result, config)
    return finish(result)
  }

  // ── Phase 3: Fetch dashboard HTML via proxy ───────────────────
  const htmlResult = await api.fetchDashboardHtml(agentSlug, dashboardSlug)
  result.timings.dashboardFirstServeMs = htmlResult.durationMs
  result.timings.totalStartToHtmlMs = performance.now() - tGlobalStart

  if (htmlResult.ok) {
    const html = htmlResult.data
    result.validations.dashboardServesHtml = true

    // Validate marker
    result.validations.dashboardHasMarker = html.includes('id="bench-marker"')
    if (!result.validations.dashboardHasMarker) {
      result.errors.push('Dashboard HTML missing bench-marker element')
    }

    // Validate polyfills injected
    const hasSpeechPolyfill = html.includes('SpeechRecognition')
    const hasLlmPolyfill = html.includes('window.Anthropic') || html.includes('_sdkReady')
    result.validations.polyfillsInjected = hasSpeechPolyfill && hasLlmPolyfill
    if (!result.validations.polyfillsInjected) {
      const missing: string[] = []
      if (!hasSpeechPolyfill) missing.push('SpeechRecognition')
      if (!hasLlmPolyfill) missing.push('LLM (window.Anthropic)')
      result.errors.push(`Missing polyfills: ${missing.join(', ')}`)
    }
  } else {
    result.errors.push(`Dashboard HTML fetch failed (HTTP ${htmlResult.status}): ${htmlResult.error}`)
  }

  // ── Phase 4: Validate SSE start event ─────────────────────────
  try {
    await sse.waitForEvent(
      (e) => e.type === 'agent_status_changed' && e.agentSlug === agentSlug && e.status === 'running',
      5_000
    )
    result.validations.sseStartEventFired = true
  } catch {
    result.validations.sseStartEventFired = false
    result.errors.push('SSE agent_status_changed(running) event not received')
  }

  // ── Phase 5: Session & message test (optional) ────────────────
  if (!config.skipSession) {
    const sessionResult = await api.createSession(
      agentSlug,
      'Reply with exactly the text BENCHMARK_OK and nothing else. No markdown, no explanation.'
    )
    result.timings.sessionCreateMs = sessionResult.durationMs
    result.validations.sessionCreated = sessionResult.ok

    if (!sessionResult.ok) {
      result.errors.push(`Session creation failed (HTTP ${sessionResult.status}): ${sessionResult.error}`)
    } else {
      // Poll for assistant response
      const msgPollStart = performance.now()
      let messageReceived = false
      const sessionId = sessionResult.data.id

      while (performance.now() - msgPollStart < 90_000) {
        const messagesResult = await api.getMessages(agentSlug, sessionId)
        if (messagesResult.ok) {
          const assistantMsg = messagesResult.data.find(
            (m) => m.type === 'assistant' && m.content?.text
          )
          if (assistantMsg) {
            messageReceived = true
            break
          }
        }
        await sleep(1_000)
      }

      result.timings.messageProcessMs = performance.now() - msgPollStart
      result.validations.messageReceived = messageReceived

      if (!messageReceived) {
        result.errors.push('No assistant response received within 90s')
      }
    }
  }

  // ── Phase 6: Stop container ───────────────────────────────────
  await doStop(api, agentSlug, sse, result, config)

  return finish(result)
}

async function doStop(
  api: ApiClient,
  agentSlug: string,
  sse: SseListener,
  result: CycleResult,
  _config: Config
): Promise<void> {
  const stopResult = await api.stopAgent(agentSlug)
  result.timings.stopMs = stopResult.durationMs
  result.validations.stopWorked = stopResult.ok && stopResult.data?.status === 'stopped'

  if (!result.validations.stopWorked) {
    result.errors.push(`Stop failed: ok=${stopResult.ok}, status=${stopResult.data?.status}`)
  }

  // Validate SSE stop event
  try {
    await sse.waitForEvent(
      (e) => e.type === 'agent_status_changed' && e.agentSlug === agentSlug && e.status === 'stopped',
      10_000
    )
    result.validations.sseStopEventFired = true
  } catch {
    result.validations.sseStopEventFired = false
    result.errors.push('SSE agent_status_changed(stopped) event not received')
  }
}

function finish(result: CycleResult): CycleResult {
  result.success = result.errors.length === 0
  return result
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printCycleResult(r: CycleResult): void {
  console.log(`\n  Timings:`)
  console.log(`    Container start:       ${formatMs(r.timings.containerStartMs)}`)
  console.log(`    Dashboard start:       ${formatMs(r.timings.dashboardStartMs)}`)
  console.log(`    Dashboard first-serve: ${formatMs(r.timings.dashboardFirstServeMs)}`)
  console.log(`    Total start→HTML:      ${formatMs(r.timings.totalStartToHtmlMs)}`)
  if (r.timings.sessionCreateMs !== null) {
    console.log(`    Session create:        ${formatMs(r.timings.sessionCreateMs)}`)
  }
  if (r.timings.messageProcessMs !== null) {
    console.log(`    Message processing:    ${formatMs(r.timings.messageProcessMs)}`)
  }
  console.log(`    Stop:                  ${formatMs(r.timings.stopMs)}`)

  console.log(`\n  Validations:`)
  const v = r.validations
  const checks: Array<[string, boolean | null]> = [
    ['Container started', v.containerStarted],
    ['Dashboard running', v.dashboardRunning],
    ['Dashboard serves HTML', v.dashboardServesHtml],
    ['Dashboard marker present', v.dashboardHasMarker],
    ['Polyfills injected', v.polyfillsInjected],
    ['SSE start event fired', v.sseStartEventFired],
    ['Stop worked', v.stopWorked],
    ['SSE stop event fired', v.sseStopEventFired],
  ]
  if (v.sessionCreated !== null) checks.push(['Session created', v.sessionCreated])
  if (v.messageReceived !== null) checks.push(['Message received', v.messageReceived])

  for (const [label, passed] of checks) {
    const icon = passed ? 'PASS' : 'FAIL'
    console.log(`    [${icon}] ${label}`)
  }

  if (r.errors.length > 0) {
    console.log(`\n  Errors:`)
    for (const e of r.errors) {
      console.log(`    - ${e}`)
    }
  }
}

function computeSummary(runs: CycleResult[], config: Config): BenchmarkSummary {
  const successfulRuns = runs.filter((r) => r.success)

  const timingKeys: Array<keyof Timings> = [
    'containerStartMs',
    'dashboardStartMs',
    'dashboardFirstServeMs',
    'totalStartToHtmlMs',
    'stopMs',
    'sessionCreateMs',
    'messageProcessMs',
  ]

  const summary: Record<string, Stats> = {}
  for (const key of timingKeys) {
    const values = successfulRuns
      .map((r) => r.timings[key])
      .filter((v): v is number => v !== null && v > 0)
    if (values.length > 0) {
      summary[key] = computeStats(values)
    }
  }

  // Count validations
  let passed = 0
  let total = 0
  for (const r of runs) {
    const v = r.validations
    const checks: (boolean | null)[] = [
      v.containerStarted,
      v.dashboardRunning,
      v.dashboardServesHtml,
      v.dashboardHasMarker,
      v.polyfillsInjected,
      v.sseStartEventFired,
      v.stopWorked,
      v.sseStopEventFired,
      v.sessionCreated,
      v.messageReceived,
    ]
    for (const c of checks) {
      if (c !== null) {
        total++
        if (c) passed++
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    config,
    runs,
    summary,
    validationsPassed: passed,
    validationsTotal: total,
    allPassed: passed === total,
  }
}

function printSummary(s: BenchmarkSummary): void {
  const successCount = s.runs.filter((r) => r.success).length
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  SUMMARY  (${successCount}/${s.runs.length} runs succeeded)`)
  console.log('='.repeat(60))

  if (Object.keys(s.summary).length > 0) {
    const labels: Record<string, string> = {
      containerStartMs: 'Container start',
      dashboardStartMs: 'Dashboard start',
      dashboardFirstServeMs: 'Dashboard first-serve',
      totalStartToHtmlMs: 'Total start→HTML',
      stopMs: 'Stop',
      sessionCreateMs: 'Session create',
      messageProcessMs: 'Message processing',
    }

    console.log(`\n  ${'Metric'.padEnd(24)} ${'p50'.padStart(10)} ${'p95'.padStart(10)} ${'mean'.padStart(10)} ${'min'.padStart(10)} ${'max'.padStart(10)}`)
    console.log(`  ${'-'.repeat(24)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)}`)

    for (const [key, stats] of Object.entries(s.summary)) {
      const label = labels[key] || key
      console.log(
        `  ${label.padEnd(24)} ${formatMs(stats.p50).padStart(10)} ${formatMs(stats.p95).padStart(10)} ${formatMs(stats.mean).padStart(10)} ${formatMs(stats.min).padStart(10)} ${formatMs(stats.max).padStart(10)}`
      )
    }
  }

  console.log(`\n  Validations: ${s.validationsPassed}/${s.validationsTotal} passed`)

  if (!s.allPassed) {
    console.log('\n  FAILED CHECKS:')
    for (const r of s.runs) {
      if (!r.success) {
        console.log(`    Run ${r.run}:`)
        for (const e of r.errors) {
          console.log(`      - ${e}`)
        }
      }
    }
  }

  console.log('')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs()

  const api = new ApiClient(config.baseUrl)

  // Step 1: Verify dev server and discover data directory
  console.log('Checking dev server...')
  const serverUp = await api.healthCheck()
  if (!serverUp) {
    console.error('ERROR: Dev server is not reachable at ' + config.baseUrl)
    console.error('Start it with: npm run dev  (or  npm run dev:electron)')
    process.exit(1)
  }

  const dataDir = await api.getDataDir()
  if (!dataDir) {
    console.error('ERROR: Could not determine server data directory from GET /api/settings')
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('  Container Startup Benchmark')
  console.log('='.repeat(60))
  console.log(`  Base URL:      ${config.baseUrl}`)
  console.log(`  Runs:          ${config.runs}`)
  console.log(`  Timeout:       ${formatMs(config.timeoutMs)}`)
  console.log(`  Skip session:  ${config.skipSession}`)
  console.log(`  Data dir:      ${dataDir}`)
  console.log('')

  // Step 2: Create test agent
  const agentName = `bench-agent-${Date.now()}`
  console.log(`Creating test agent: ${agentName}...`)
  const createResult = await api.createAgent(agentName, 'Benchmark test agent — auto-created, safe to delete')
  if (!createResult.ok) {
    console.error(`ERROR: Failed to create agent: ${createResult.error}`)
    process.exit(1)
  }
  const agentSlug = createResult.data.slug
  console.log(`Agent created: ${agentSlug}`)

  // Step 3: Seed dashboard
  const dashboardSlug = 'bench-dashboard'
  console.log(`Seeding dashboard: ${dashboardSlug}...`)
  await seedDashboard(dataDir, agentSlug, dashboardSlug)
  console.log('Dashboard seeded.')

  // Verify dashboard appears in artifacts list
  const verifyArtifacts = await api.listArtifacts(agentSlug)
  if (!verifyArtifacts.ok || !verifyArtifacts.data.find((a) => a.slug === dashboardSlug)) {
    console.error('ERROR: Seeded dashboard not found in artifacts list')
    await cleanup(api, agentSlug, config)
    process.exit(1)
  }
  console.log('Dashboard verified in artifacts list (status: stopped).')

  // Step 4: Connect SSE
  let sse: SseListener | null = null
  try {
    console.log('Connecting SSE listener...')
    sse = new SseListener(config.baseUrl)
    await sse.waitForConnection()
    console.log('SSE connected.')
  } catch (err: any) {
    console.error(`WARNING: SSE connection failed: ${err.message}`)
    console.error('SSE validations will fail but other tests will proceed.')
    sse = null
  }

  // Register cleanup handlers
  let cleanupDone = false
  const doCleanup = async () => {
    if (cleanupDone) return
    cleanupDone = true
    sse?.close()
    await cleanup(api, agentSlug, config)
  }

  process.on('SIGINT', async () => {
    console.log('\nInterrupted. Cleaning up...')
    await doCleanup()
    process.exit(130)
  })

  process.on('SIGTERM', async () => {
    await doCleanup()
    process.exit(143)
  })

  // Step 5: Run benchmark cycles
  const results: CycleResult[] = []

  try {
    for (let i = 0; i < config.runs; i++) {
      console.log(`\n--- Run ${i + 1}/${config.runs} ---`)

      // Create a per-cycle SSE listener if the shared one failed
      const cycleSSE = sse || createFallbackSse()

      const result = await runCycle(api, agentSlug, dashboardSlug, cycleSSE, config, i + 1)
      results.push(result)
      printCycleResult(result)

      if (cycleSSE !== sse) cycleSSE.close()

      // Let things settle between cycles
      if (i < config.runs - 1) {
        console.log('\n  Waiting 3s before next cycle...')
        await sleep(3_000)
      }
    }
  } finally {
    await doCleanup()
  }

  // Step 6: Print summary
  const summary = computeSummary(results, config)
  printSummary(summary)

  // Step 7: Write JSON output
  if (config.jsonOut) {
    fs.writeFileSync(config.jsonOut, JSON.stringify(summary, null, 2))
    console.log(`Results written to: ${config.jsonOut}`)
  }

  // Always print JSON to stdout for piping
  console.log('\n--- JSON Results ---')
  console.log(JSON.stringify(summary, null, 2))

  // Exit with code based on validation results
  process.exit(summary.allPassed ? 0 : 1)
}

async function cleanup(api: ApiClient, agentSlug: string, config: Config): Promise<void> {
  // Always try to stop first (DELETE doesn't stop the container)
  console.log('Stopping agent...')
  await api.stopAgent(agentSlug).catch(() => {})

  if (!config.keepAgent) {
    console.log('Deleting agent...')
    await api.deleteAgent(agentSlug).catch(() => {})
    console.log('Agent deleted.')
  } else {
    console.log(`Agent kept: ${agentSlug}`)
  }
}

// Fallback SSE that always fails validations gracefully
function createFallbackSse(): SseListener {
  return {
    clearEvents() {},
    getEvents() { return [] },
    waitForEvent() { return Promise.reject(new Error('SSE not available')) },
    waitForConnection() { return Promise.resolve() },
    close() {},
  } as unknown as SseListener
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
