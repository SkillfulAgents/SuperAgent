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
 * Coverage:
 *   - `fs.promises.*` and `FileHandle#read/stat/readFile` (which includes
 *     `fileHandle.createReadStream()`, reading via `FileHandle#read`): counted
 *     AND delayed. This is everything the storage layer uses today.
 *   - Sync entry points (`fs.statSync`, `fs.readFileSync`, …) and
 *     `fs.createReadStream(path)`: counted, not delayed (a sync call cannot
 *     be suspended). They exist so that a route rewritten onto the sync API
 *     shows up as an op-count change instead of silently vanishing from both
 *     the counts and the wall-clock.
 *   - `import { stat } from 'fs/promises'` — the ESM namespace of a builtin
 *     snapshots its exports, so after patching we call `syncBuiltinESMExports`
 *     to push the wrapped functions into every namespace import as well.
 *   - Not covered: the callback API (`fs.stat(path, cb)`), `readline` over a
 *     path. Nothing in `src/` uses them on a request path.
 */
import type * as FsModule from 'fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'

// The CJS module object: its properties are writable, unlike an ESM
// namespace's. Everything we patch here is pushed into the ESM namespaces by
// `syncBuiltinESMExports()` at the end of install.
const fs = createRequire(__filename)('fs') as typeof FsModule

const PROMISE_OPS = [
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
  'appendFile',
] as const

const HANDLE_OPS = ['handle.read', 'handle.stat', 'handle.readFile'] as const

const SYNC_OPS = [
  'sync.statSync',
  'sync.lstatSync',
  'sync.readdirSync',
  'sync.readFileSync',
  'sync.existsSync',
  'sync.accessSync',
  'sync.openSync',
  'sync.mkdirSync',
  'sync.writeFileSync',
  'sync.appendFileSync',
  'sync.renameSync',
  'sync.unlinkSync',
  'sync.rmSync',
  'sync.realpathSync',
  'sync.copyFileSync',
  'sync.createReadStream',
] as const

export const FS_OPS = [...PROMISE_OPS, ...HANDLE_OPS, ...SYNC_OPS] as const

export type FsOp = (typeof FS_OPS)[number]
export type FsOpCounts = Partial<Record<FsOp, number>>

interface ShimState {
  installed: boolean
  enabled: boolean
  latencyMs: number
  counts: Map<FsOp, number>
  bytesRead: number
}

export const DEFAULT_LATENCY_MS = 10

const state: ShimState = {
  installed: false,
  enabled: false,
  latencyMs: readLatencyFromEnv(),
  counts: new Map(),
  bytesRead: 0,
}

function readLatencyFromEnv(): number {
  const raw = process.env.NFS_SIM_LATENCY_MS
  if (raw === undefined || raw === '') return DEFAULT_LATENCY_MS
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

type AnyFn = (...args: unknown[]) => unknown
type AnyAsyncFn = (...args: unknown[]) => Promise<unknown>

function original<T extends object>(target: T, method: string): AnyFn {
  const fn = (target as Record<string, unknown>)[method]
  if (typeof fn !== 'function') {
    throw new Error(`nfs-shim: cannot wrap missing method ${method}`)
  }
  return fn as AnyFn
}

function install<T extends object>(target: T, method: string, wrapped: AnyFn, name: string): void {
  Object.defineProperty(wrapped, 'name', { value: name })
  ;(target as Record<string, unknown>)[method] = wrapped
}

/** Counted and delayed. */
function wrapAsync<T extends object>(target: T, method: string, op: FsOp): void {
  const fn = original(target, method) as AnyAsyncFn
  install(target, method, async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    if (!state.enabled) return fn.apply(this, args)
    record(op)
    if (state.latencyMs > 0) await sleep(state.latencyMs)
    const result = await fn.apply(this, args)
    if (op === 'handle.read' && result && typeof result === 'object' && 'bytesRead' in result) {
      state.bytesRead += Number((result as { bytesRead: number }).bytesRead)
    }
    return result
  }, fn.name)
}

/** Counted only. */
function wrapSync<T extends object>(target: T, method: string, op: FsOp): void {
  const fn = original(target, method)
  install(target, method, function (this: unknown, ...args: unknown[]): unknown {
    if (state.enabled) record(op)
    return fn.apply(this, args)
  }, fn.name)
}

/**
 * Patch `fs`, `fs.promises` and `FileHandle.prototype`. Idempotent. Async
 * because the FileHandle class is not exported: its prototype is obtained
 * from a real handle.
 */
export async function installNfsShim(): Promise<void> {
  if (state.installed) return
  state.installed = true

  for (const op of PROMISE_OPS) wrapAsync(fs.promises, op, op)
  for (const op of SYNC_OPS) wrapSync(fs, op.slice('sync.'.length), op)

  // `open` is wrapped above (counted + delayed); disable around this probe so
  // installing the shim never contributes to a measurement.
  const wasEnabled = state.enabled
  state.enabled = false
  try {
    const probe = await fs.promises.open(__filename, 'r')
    const proto = Object.getPrototypeOf(probe) as object
    await probe.close()
    wrapAsync(proto, 'read', 'handle.read')
    wrapAsync(proto, 'stat', 'handle.stat')
    wrapAsync(proto, 'readFile', 'handle.readFile')
  } finally {
    state.enabled = wasEnabled
  }

  // Push the wrapped functions into `import * as fs from 'node:fs'` /
  // `import { stat } from 'fs/promises'` namespaces, which otherwise keep
  // the originals.
  syncBuiltinESMExports()
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
