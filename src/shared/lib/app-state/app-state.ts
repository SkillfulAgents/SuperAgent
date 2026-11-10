/**
 * The process's AppState, initialized explicitly by its entry point (Electron
 * main, the web server, the Vite dev server, the perf harness) before anything
 * that uses it runs, like the database. Importing this module selects no
 * backend and does no I/O; `appState()` before initialization throws.
 *
 * It serves one stable scope for the life of the process. A deployment that
 * serves a tenant from its own isolate installs its implementation for that
 * tenant at its entry point; consumers do not change.
 */
import type { AppState } from './contract'
import { createLocalAppState } from './local-app-state'

interface Initialization {
  done: Promise<AppState>
  /** Set by `closeAppState()`: the backend is closed when it arrives instead of installed. */
  cancelled: boolean
}

interface Holder {
  installed: AppState | null
  initializing: Initialization | null
}

// On globalThis rather than in this module, so another instance of the module
// (a test's vi.resetModules(), Vite re-instantiating it after an edit) serves
// the same AppState instead of an uninitialized one. Holds no backend until an
// entry point installs one.
const HOLDER = Symbol.for('superagent.app-state')
const holder = ((globalThis as Record<symbol, Holder | undefined>)[HOLDER] ??= { installed: null, initializing: null })

/**
 * The installed AppState. Call it at each use rather than keeping the result,
 * so a test's fresh instance is the one in use.
 */
export function appState(): AppState {
  if (!holder.installed) {
    throw new Error('AppState is not initialized. The entry point must await initializeAppState() before anything uses it.')
  }
  return holder.installed
}

export function isAppStateInitialized(): boolean {
  return holder.installed !== null
}

/**
 * Installs the process's AppState, once. Awaits an implementation that
 * connects first; a ready one is installed before this returns, so a caller
 * that checks `isAppStateInitialized()` first cannot race another.
 */
export function initializeAppState(state: AppState | Promise<AppState>): Promise<AppState> {
  if (holder.installed || holder.initializing) {
    return Promise.reject(new Error('AppState is already initialized; an entry point initializes it once.'))
  }
  if (!(state instanceof Promise)) {
    holder.installed = state
    return Promise.resolve(state)
  }
  const initialization = { cancelled: false } as Initialization
  initialization.done = install(initialization, state)
  holder.initializing = initialization
  return initialization.done
}

async function install(initialization: Initialization, state: Promise<AppState>): Promise<AppState> {
  try {
    const connected = await state
    if (initialization.cancelled) {
      await connected.close()
      throw new Error('AppState was closed while it was initializing')
    }
    holder.installed = connected
    return connected
  } finally {
    if (holder.initializing === initialization) holder.initializing = null
  }
}

/** Installs this process's memory as the AppState: desktop and single-tenant web. */
export function initializeLocalAppState(): Promise<AppState> {
  return initializeAppState(createLocalAppState())
}

/**
 * Closes and forgets the AppState; `appState()` throws until the next
 * initialization. An initialization still connecting is cancelled and waited
 * for, so once this resolves nothing it started is left open. For shutdown and
 * tests.
 */
export async function closeAppState(): Promise<void> {
  const initialization = holder.initializing
  if (initialization) {
    initialization.cancelled = true
    holder.initializing = null
    // Its own caller gets the rejection; this only waits for the backend to close.
    await initialization.done.catch(() => {})
  }
  const state = holder.installed
  holder.installed = null
  if (state) await state.close()
}
