import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostStateEntry, HostStateStore } from './store'

/**
 * Per-request view of the shared host state. The request reads one snapshot
 * synchronously; each write changes the snapshot at once and queues a
 * compare-and-set save that re-applies the change to the stored value on a
 * conflict. The request is not finished until its saves are.
 *
 * With no scope (desktop, ECS) callers keep their file-backed paths.
 */

export const SETTINGS_KEY = 'settings'
const FILE_PREFIX = 'file:'
const MAX_ATTEMPTS = 10

export class HostStateConflictError extends Error {
  constructor(key: string) {
    super(`Host state "${key}" changed in another request`)
  }
}

interface Scope {
  store: HostStateStore
  /** Last value seen in the store per key, the base for the next save. */
  stored: Map<string, HostStateEntry>
  /** What this request sees: `stored` plus its own queued writes. */
  local: Map<string, string>
  memo: Map<string, unknown>
  /** Newest write per key, so a rebase does not hide a later queued write. */
  lastWrite: Map<string, number>
  pending: Promise<void>
  failure: unknown
}

const als = new AsyncLocalStorage<Scope>()
const singletons = new Map<string, () => string>()

/** A host file made once and never rewritten (a key, an id). Each scope ensures it exists before the request runs. */
export function defineSingletonHostFile(name: string, create: () => string): void {
  singletons.set(name, create)
}

export function hostStateActive(): boolean {
  return als.getStore() !== undefined
}

export async function runWithHostState<T>(store: HostStateStore, fn: () => Promise<T>): Promise<T> {
  const stored = await store.getMany([SETTINGS_KEY], [FILE_PREFIX])
  for (const [name, create] of singletons) {
    const key = FILE_PREFIX + name
    if (!stored.has(key)) stored.set(key, await store.insertIfAbsent(key, create()))
  }
  const local = new Map([...stored].map(([k, e]) => [k, e.value]))
  const scope: Scope = { store, stored, local, memo: new Map(), lastWrite: new Map(), pending: Promise.resolve(), failure: null }
  const result = await als.run(scope, fn)
  await flush(scope)
  return result
}

async function flush(scope: Scope): Promise<void> {
  await scope.pending
  if (scope.failure) throw scope.failure
}

/** Waits for this request's queued saves; a no-op outside a scope. */
export async function flushHostState(): Promise<void> {
  const scope = als.getStore()
  if (scope) await flush(scope)
}

function scopeOrThrow(): Scope {
  const scope = als.getStore()
  if (!scope) throw new Error('No host state scope')
  return scope
}

export function readScoped(key: string): string | null {
  return scopeOrThrow().local.get(key) ?? null
}

/** Parsed value cached for the rest of the request; dropped when the key changes. */
export function memoScoped<T>(key: string, parse: (raw: string | null) => T): T {
  const scope = scopeOrThrow()
  if (!scope.memo.has(key)) scope.memo.set(key, parse(scope.local.get(key) ?? null))
  return scope.memo.get(key) as T
}

/**
 * Applies `update` to this request's value now and queues the save. On a
 * conflict the save reloads the stored value and applies `update` again,
 * the way a fresh read-modify-write would. `rebase: false` fails the save
 * instead (for a whole-document replace).
 */
export function writeScoped(
  key: string,
  update: (current: string | null) => string,
  options: { rebase?: boolean } = {},
): string {
  const scope = scopeOrThrow()
  const localBase = scope.local.get(key) ?? null
  const next = update(localBase)
  scope.local.set(key, next)
  scope.memo.delete(key)
  const seq = (scope.lastWrite.get(key) ?? 0) + 1
  scope.lastWrite.set(key, seq)
  scope.pending = scope.pending.then(() => save(scope, key, seq, update, options.rebase ?? true, localBase, next)).catch((error) => {
    scope.failure ??= error
  })
  return next
}

async function save(
  scope: Scope,
  key: string,
  seq: number,
  update: (current: string | null) => string,
  rebase: boolean,
  localBase: string | null,
  localNext: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const base = scope.stored.get(key) ?? null
    // Unchanged base: keep the value the caller already got, so an update with
    // side effects (a new id) runs again only on a real conflict.
    const value = (base?.value ?? null) === localBase ? localNext : update(base?.value ?? null)
    const version = await scope.store.compareAndSet(key, value, base?.version ?? 0)
    if (version !== null) {
      scope.stored.set(key, { value, version })
      return
    }
    if (!rebase) throw new HostStateConflictError(key)
    // Jittered backoff: many writers on one key otherwise collide in lockstep.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * 2 ** Math.min(attempt, 4)))
    const latest = await scope.store.get(key)
    if (latest) scope.stored.set(key, latest)
    else scope.stored.delete(key)
    // Later reads in this request see the other writer's change merged in.
    if (scope.lastWrite.get(key) === seq) {
      scope.local.set(key, update(latest?.value ?? null))
      scope.memo.delete(key)
    }
  }
  throw new HostStateConflictError(key)
}

export function hostFileKey(name: string): string {
  return FILE_PREFIX + name
}

/** This request's store, or null outside a scope. */
export function scopedStore(): HostStateStore | null {
  return als.getStore()?.store ?? null
}
