/**
 * The process's TaskManager and ServiceHost, initialized explicitly by its entry
 * point (Electron main, the web server, the Vite dev server, the perf harness)
 * before it serves anything, after the database and AppState. Importing this
 * module selects no backend, starts no timer and does no I/O; `taskManager()`
 * and `serviceHost()` before initialization throw.
 */
import { LocalTaskManager } from './local-task-manager'
import { ServiceHost } from './service-host'
import type { TaskManager } from './task'

interface Holder {
  taskManager: TaskManager | null
  serviceHost: ServiceHost | null
}

// On globalThis rather than in this module, so another instance of the module (a
// test's vi.resetModules(), Vite re-instantiating it after an edit) serves the
// same manager, whose timers it could not otherwise reach.
const HOLDER = Symbol.for('superagent.background-work')
const holder = ((globalThis as Record<symbol, Holder | undefined>)[HOLDER] ??= { taskManager: null, serviceHost: null })

/**
 * The installed TaskManager. Call it at each use rather than keeping the result,
 * so a test's fresh instance is the one in use. After shutdown it still answers,
 * with a manager that ignores what it is given, so a late callback has nothing
 * to resurrect and nothing to throw.
 */
export function taskManager(): TaskManager {
  if (!holder.taskManager) {
    throw new Error('Background work is not initialized. The entry point must await initializeLocalBackgroundWork() before anything schedules work.')
  }
  return holder.taskManager
}

/** The installed ServiceHost. Call it at each use, as with `taskManager()`. */
export function serviceHost(): ServiceHost {
  if (!holder.serviceHost) {
    throw new Error('Background work is not initialized. The entry point must await initializeLocalBackgroundWork() before anything registers a service.')
  }
  return holder.serviceHost
}

export function isBackgroundWorkInitialized(): boolean {
  return holder.serviceHost !== null
}

/**
 * Installs the process's manager and host, once. They are installed before this
 * returns, so a caller that checks `isBackgroundWorkInitialized()` first cannot
 * race another.
 */
export function initializeBackgroundWork(manager: TaskManager): Promise<void> {
  if (isBackgroundWorkInitialized()) {
    return Promise.reject(new Error('Background work is already initialized; an entry point initializes it once.'))
  }
  holder.taskManager = manager
  holder.serviceHost = new ServiceHost(manager)
  return manager.start()
}

/** Installs dispatch on this process's timers: desktop and single-tenant web. */
export function initializeLocalBackgroundWork(): Promise<void> {
  return initializeBackgroundWork(new LocalTaskManager())
}

/** Stops everything and forgets it; `taskManager()` throws until the next initialization. For tests. */
export async function closeBackgroundWork(): Promise<void> {
  const host = holder.serviceHost
  holder.taskManager = null
  holder.serviceHost = null
  await host?.stop()
}
