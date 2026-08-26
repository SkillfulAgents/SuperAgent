/**
 * Boots the real API router in-process against a seeded temp data dir and
 * measures requests under the NFS shim.
 *
 * No network: requests go through `app.request()`. The database is the real
 * sqlite file in the temp dir (migrated during boot, outside any measurement).
 * The container runtime is the E2E mock client, so agent status comes from the
 * in-memory cache and never spawns docker.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { expect } from 'vitest'
import type { Hono } from 'hono'
import { PROFILES, seedDataDir, type SeedProfile, type SeededData } from './fixtures'
import {
  disableNfsShim,
  enableNfsShim,
  nfsShimLatencyMs,
  nfsShimSnapshot,
  resetNfsShimCounters,
  type FsOp,
  type FsOpCounts,
} from './nfs-shim'

/** Wall-clock budgets are stated at this simulated latency. */
export const BUDGET_LATENCY_MS = 2

export interface PerfApp {
  app: Hono
  seeded: SeededData
  profile: SeedProfile
  request(url: string): Promise<Response>
  /** Drop the per-agent session summary caches so the next read is cold. */
  invalidateSummaryCaches(): void
  dispose(): Promise<void>
}

export async function bootPerfApp(profileName: keyof typeof PROFILES): Promise<PerfApp> {
  const profile = PROFILES[profileName]
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `superagent-perf-${profile.name}-`))
  const seeded = await seedDataDir(dataDir, profile)

  const previousEnv = {
    SUPERAGENT_DATA_DIR: process.env.SUPERAGENT_DATA_DIR,
    E2E_MOCK: process.env.E2E_MOCK,
  }
  process.env.SUPERAGENT_DATA_DIR = dataDir
  process.env.E2E_MOCK = 'true'

  // Env must be set before these modules load: the container manager reads
  // E2E_MOCK at construction and the db resolves its path on first access.
  const { sqlite } = await import('@shared/lib/db')
  sqlite.prepare('select 1').get()
  const { Hono: HonoCtor } = await import('hono')
  const agentsRouter = (await import('@/api/routes/agents')).default
  const { invalidateSessionSummaryCache } = await import('@shared/lib/services/session-summary-cache')

  const app = new HonoCtor()
  app.route('/api/agents', agentsRouter)

  return {
    app,
    seeded,
    profile,
    request: async (url) => app.request(`http://localhost${url}`),
    invalidateSummaryCaches: () => {
      for (const slug of seeded.agentSlugs) invalidateSessionSummaryCache(slug)
    },
    dispose: async () => {
      disableNfsShim()
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.promises.rm(dataDir, { recursive: true, force: true })
    },
  }
}

export interface Measurement {
  wallMs: number
  counts: FsOpCounts
  totalOps: number
  bytesRead: number
}

/** Run `fn` with the shim enabled; everything outside runs at native speed. */
export async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; measurement: Measurement }> {
  resetNfsShimCounters()
  enableNfsShim()
  const started = performance.now()
  try {
    const result = await fn()
    const wallMs = performance.now() - started
    const snapshot = nfsShimSnapshot()
    return { result, measurement: { wallMs, ...snapshot } }
  } finally {
    disableNfsShim()
  }
}

export interface Budget {
  /** Per-operation ceilings. Ops not listed are unconstrained individually. */
  ops?: FsOpCounts
  /** Ceiling on the sum of all counted operations. */
  totalOps: number
  /** Ceiling on wall-clock at BUDGET_LATENCY_MS simulated latency. */
  wallMs: number
  bytesRead?: number
}

/** Bypass console capture so the numbers always land in the run's log. */
function report(text: string): void {
  process.stdout.write(text)
}

/**
 * One JSON line per measurement in PERF_RESULTS_FILE (default
 * perf-results.jsonl in the cwd), for CI artifacts and re-baselining.
 */
function appendResult(row: Record<string, unknown>): void {
  const file = process.env.PERF_RESULTS_FILE ?? path.resolve('perf-results.jsonl')
  fs.appendFileSync(file, JSON.stringify(row) + '\n')
}

function formatCounts(counts: FsOpCounts): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([op, n]) => `${op}=${n}`)
    .join(' ')
}

/**
 * Print the measurement (always — CI logs should carry the numbers) and
 * assert it against the budget. With PERF_RECORD=1 the assertions are
 * reported instead of enforced, for re-baselining after an intentional change.
 */
export function expectWithinBudget(label: string, m: Measurement, budget: Budget): void {
  const record = process.env.PERF_RECORD === '1'
  const latency = nfsShimLatencyMs()
  const wallEnforced = latency === BUDGET_LATENCY_MS

  report(
    `[perf] ${label}\n` +
    `       wall=${m.wallMs.toFixed(0)}ms (budget ${budget.wallMs}ms${wallEnforced ? '' : ', not enforced at latency ' + latency + 'ms'})` +
    ` ops=${m.totalOps} (budget ${budget.totalOps}) bytesRead=${m.bytesRead}\n` +
    `       ${formatCounts(m.counts)}\n`,
  )
  appendResult({ label, latencyMs: latency, wallMs: Math.round(m.wallMs), totalOps: m.totalOps, bytesRead: m.bytesRead, counts: m.counts, budget })

  const failures: string[] = []
  const check = (what: string, actual: number, limit: number | undefined) => {
    if (limit === undefined) return
    if (actual > limit) failures.push(`${what}: ${actual} > ${limit}`)
  }
  check('totalOps', m.totalOps, budget.totalOps)
  if (wallEnforced) check('wallMs', Math.round(m.wallMs), budget.wallMs)
  check('bytesRead', m.bytesRead, budget.bytesRead)
  for (const [op, limit] of Object.entries(budget.ops ?? {}) as [FsOp, number][]) {
    check(op, m.counts[op] ?? 0, limit)
  }

  if (failures.length === 0) return
  const message = `[perf] ${label} exceeded budget:\n  ${failures.join('\n  ')}`
  if (record) {
    report(message + '\n  (PERF_RECORD=1: reported, not enforced)\n')
    return
  }
  expect.fail(message)
}
