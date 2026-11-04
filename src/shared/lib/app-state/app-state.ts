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

let installed: AppState | null = null
let initializing = false

/**
 * The installed AppState. Call it at each use rather than keeping the result,
 * so a test's fresh instance is the one in use.
 */
export function appState(): AppState {
  if (!installed) {
    throw new Error('AppState is not initialized. The entry point must await initializeAppState() before anything uses it.')
  }
  return installed
}

export function isAppStateInitialized(): boolean {
  return installed !== null
}

/**
 * Installs the process's AppState, once. Awaits an implementation that
 * connects first; a ready one is installed before this returns, so a caller
 * that checks `isAppStateInitialized()` first cannot race another.
 */
export async function initializeAppState(state: AppState | Promise<AppState>): Promise<AppState> {
  if (installed || initializing) throw new Error('AppState is already initialized; an entry point initializes it once.')
  if (!(state instanceof Promise)) {
    installed = state
    return state
  }
  initializing = true
  try {
    installed = await state
    return installed
  } finally {
    initializing = false
  }
}

/** Installs this process's memory as the AppState: desktop and single-tenant web. */
export function initializeLocalAppState(): Promise<AppState> {
  return initializeAppState(createLocalAppState())
}

/** Closes and forgets the installed AppState; `appState()` throws until the next initialization. For shutdown and tests. */
export async function closeAppState(): Promise<void> {
  const state = installed
  installed = null
  if (state) await state.close()
}
