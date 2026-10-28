/**
 * Work that nobody awaits: started after a response, or inside a service.
 *
 * A bare `void f()` has two problems. A rejection reaches the process's
 * `unhandledRejection` handler, which quits the Electron app; and on Workers,
 * work still running after the response is cancelled unless it is handed to
 * `waitUntil`. In `src/api` and `src/shared/lib` such work goes through
 * `background()` instead (lint rule `local-rules/no-floating-work`).
 *
 * The work starts at once, exactly as with `void`: a function is called
 * synchronously. A rejection is logged and reported, tagged with `name`, and
 * goes no further. The work is tracked until it settles, so a test can wait
 * for it with `backgroundSettled()`.
 */
import { captureException } from './error-reporting'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Where the current request hands work that must outlive its response, if it can. */
const requestLifetime = new AsyncLocalStorage<(work: Promise<unknown>) => void>()

interface Entry {
  name: string
  work: WeakRef<Promise<void>>
}

// Held weakly: work that can never settle (nothing is left that could resolve
// it, like a promise waiting on a stream that closed without aborting) is
// collected as it was after `void`, instead of being pinned here forever.
const inFlight = new Set<Entry>()
const collected = new FinalizationRegistry<Entry>(leave)
// Woken whenever an entry leaves, by settling or by being collected.
const waiters = new Set<() => void>()

function leave(entry: Entry): void {
  if (!inFlight.delete(entry)) return
  for (const wake of waiters) wake()
  waiters.clear()
}

export function background(work: PromiseLike<unknown> | (() => PromiseLike<unknown>), options: { name: string }): void {
  const { name } = options
  let started: PromiseLike<unknown>
  try {
    started = typeof work === 'function' ? work() : work
  } catch (error) {
    started = Promise.reject(error)
  }
  const settle = () => {
    collected.unregister(entry)
    leave(entry)
  }
  const tracked = Promise.resolve(started).then(settle, (error: unknown) => {
    settle()
    reportFailure(name, error)
  })
  const entry: Entry = { name, work: new WeakRef(tracked) }
  inFlight.add(entry)
  collected.register(tracked, entry, entry)
  requestLifetime.getStore()?.(tracked)
}


/**
 * Runs `fn` with a way to keep its request alive for the background work it
 * starts: a Worker passes its `ctx.waitUntil`. Work started outside one runs
 * as before.
 */
export function runWithRequestLifetime<T>(waitUntil: (work: Promise<unknown>) => void, fn: () => T): T {
  return requestLifetime.run(waitUntil, fn)
}

function reportFailure(name: string, error: unknown): void {
  console.error(`[background] ${name} failed:`, error)
  captureException(error, { tags: { background: name } })
  // A test run still fails on it, as it did when this was an unhandled rejection.
  if (process.env.VITEST) queueMicrotask(() => { throw error })
}

function pending(): Array<{ name: string; work: Promise<void> }> {
  const live: Array<{ name: string; work: Promise<void> }> = []
  for (const entry of inFlight) {
    const work = entry.work.deref()
    if (work) live.push({ name: entry.name, work })
  }
  return live
}

/** The names of the work still in flight, oldest first. */
export function backgroundInFlight(): string[] {
  return pending().map((entry) => entry.name)
}

function anyPending(): boolean {
  for (const entry of inFlight) if (entry.work.deref()) return true
  return false
}

/**
 * Resolves once nothing is in flight, including work started while it waits.
 * It never holds the work itself, so work that can never settle is collected
 * and stops counting.
 */
export async function backgroundSettled(): Promise<void> {
  while (anyPending()) await new Promise<void>((resolve) => waiters.add(resolve))
}
