/**
 * Simulated network-filesystem cost for the perf suite.
 *
 * Many deployments keep agent data on NFS-class volumes (EFS, S3 Files), where
 * every metadata operation is a network round trip. On a developer laptop or a
 * CI runner the same operations hit page cache and cost microseconds, so a
 * route that issues 5 000 stats looks fine locally and takes seconds in
 * production.
 *
 * This shim wraps the `fs.promises` entry points and the `FileHandle` methods
 * the services use, adding a fixed artificial latency per call and counting
 * calls per operation. While enabled, wall-clock ≈ latency × (ops on the
 * critical path), which makes two things measurable and reproducible:
 *
 *   - op counts: deterministic, zero noise — catches "stats every transcript"
 *   - wall-clock at a fixed latency — catches serialised work that op counts
 *     alone cannot see (a `for … await` where a `Promise.all` was intended)
 *
 * The shim is installed once per process and starts DISABLED so fixture
 * seeding runs at native speed; `measure()` in the harness enables it around
 * the code under test only.
 *
 * Coverage: everything in this codebase's storage layer goes through
 * `fs.promises.*` and `FileHandle#read/stat` (including
 * `fileHandle.createReadStream()`, which reads via `FileHandle#read`). The
 * callback API (`fs.stat(path, cb)`) and `fs.createReadStream(path)` are not
 * wrapped; if a code path starts using them, its ops disappear from the
 * counts, so keep an eye on `bytesRead`.
 */
import * as fs from 'fs'

export const FS_OPS = [
  'stat',
  'lstat',
  'readdir',
  'readFile',
  'open',
  'access',
  'mkdir',
  'writeFile',
  'rename',
  'unlink',
  'rm',
  'realpath',
  'utimes',
  'copyFile',
  'opendir',
  'handle.read',
  'handle.stat',
  'handle.readFile',
] as const

export type FsOp = (typeof FS_OPS)[number]
export type FsOpCounts = Partial<Record<FsOp, number>>

interface ShimState {
  installed: boolean
  enabled: boolean
  latencyMs: number
  counts: Map<FsOp, number>
  bytesRead: number
}

const state: ShimState = {
  installed: false,
  enabled: false,
  latencyMs: readLatencyFromEnv(),
  counts: new Map(),
  bytesRead: 0,
}

function readLatencyFromEnv(): number {
  const raw = process.env.NFS_SIM_LATENCY_MS
  if (raw === undefined || raw === '') return 2
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`NFS_SIM_LATENCY_MS must be a non-negative number, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function record(op: FsOp): void {
  state.counts.set(op, (state.counts.get(op) ?? 0) + 1)
}

type AnyAsyncFn = (...args: unknown[]) => Promise<unknown>

function wrap<T extends object>(target: T, method: keyof T & string, op: FsOp): void {
  const original = target[method] as unknown as AnyAsyncFn
  if (typeof original !== 'function') {
    throw new Error(`nfs-shim: cannot wrap missing method ${String(method)}`)
  }
  const wrapped = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    if (!state.enabled) return original.apply(this, args)
    record(op)
    if (state.latencyMs > 0) await sleep(state.latencyMs)
    const result = await original.apply(this, args)
    if (op === 'handle.read' && result && typeof result === 'object' && 'bytesRead' in result) {
      state.bytesRead += Number((result as { bytesRead: number }).bytesRead)
    }
    return result
  }
  Object.defineProperty(wrapped, 'name', { value: original.name })
  ;(target as Record<string, unknown>)[method] = wrapped
}

/**
 * Patch `fs.promises` and `FileHandle.prototype`. Idempotent. Async because the
 * FileHandle class is not exported: its prototype is obtained from a real
 * handle.
 */
export async function installNfsShim(): Promise<void> {
  if (state.installed) return
  state.installed = true

  const p = fs.promises as unknown as Record<string, AnyAsyncFn>
  for (const op of [
    'stat', 'lstat', 'readdir', 'readFile', 'open', 'access', 'mkdir', 'writeFile',
    'rename', 'unlink', 'rm', 'realpath', 'utimes', 'copyFile', 'opendir',
  ] as const) {
    wrap(p, op, op)
  }

  // `open` is wrapped above (counted + delayed); disable around this probe so
  // installing the shim never contributes to a measurement.
  const wasEnabled = state.enabled
  state.enabled = false
  try {
    const probe = await fs.promises.open(__filename, 'r')
    const proto = Object.getPrototypeOf(probe) as Record<string, AnyAsyncFn>
    await probe.close()
    wrap(proto, 'read', 'handle.read')
    wrap(proto, 'stat', 'handle.stat')
    wrap(proto, 'readFile', 'handle.readFile')
  } finally {
    state.enabled = wasEnabled
  }
}

export function enableNfsShim(): void {
  if (!state.installed) throw new Error('nfs-shim: installNfsShim() has not run')
  state.enabled = true
}

export function disableNfsShim(): void {
  state.enabled = false
}

export function resetNfsShimCounters(): void {
  state.counts.clear()
  state.bytesRead = 0
}

export function nfsShimSnapshot(): { counts: FsOpCounts; totalOps: number; bytesRead: number } {
  const counts: FsOpCounts = {}
  let totalOps = 0
  for (const op of FS_OPS) {
    const n = state.counts.get(op)
    if (n) {
      counts[op] = n
      totalOps += n
    }
  }
  return { counts, totalOps, bytesRead: state.bytesRead }
}

export function nfsShimLatencyMs(): number {
  return state.latencyMs
}
