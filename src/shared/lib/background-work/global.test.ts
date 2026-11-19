import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeBackgroundWork,
  initializeBackgroundWork,
  isBackgroundWorkInitialized,
  serviceHost,
  stopBackgroundWork,
  taskManager,
} from './global'
import { LocalTaskManager } from './local-task-manager'
import { TaskManager } from './task'

/** A backend that is not this process's timers. */
class OtherBackend extends TaskManager {
  register(): void {}
  handles(): boolean { return false }
  async at(): Promise<void> {}
  async ensureEvery(): Promise<void> {}
  async cancel(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('the installed task manager and service host', () => {
  beforeEach(async () => {
    await closeBackgroundWork()
  })

  afterEach(async () => {
    await closeBackgroundWork()
  })

  it('throws until an entry point installs them', () => {
    expect(isBackgroundWorkInitialized()).toBe(false)
    expect(() => taskManager()).toThrow('Background work is not initialized')
    expect(() => serviceHost()).toThrow('Background work is not initialized')
  })

  it('installs the manager, already started, before it returns', async () => {
    vi.useFakeTimers()
    try {
      const manager = new LocalTaskManager()
      const installing = initializeBackgroundWork(manager)
      expect(isBackgroundWorkInitialized()).toBe(true)
      expect(taskManager()).toBe(manager)
      await installing
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a second initialization', async () => {
    await initializeBackgroundWork(new LocalTaskManager())
    await expect(initializeBackgroundWork(new LocalTaskManager())).rejects.toThrow('already initialized')
  })

  it('takes any backend', async () => {
    const manager = new OtherBackend()
    const start = vi.spyOn(manager, 'start')
    await initializeBackgroundWork(manager)
    expect(taskManager()).toBe(manager)
    expect(start).toHaveBeenCalledOnce()
  })

  it('leaves the backend to the entry point: importing the package does not load the local manager', async () => {
    vi.resetModules()
    vi.doMock('./local-task-manager', () => {
      throw new Error('the package loaded the local manager')
    })
    try {
      await expect(import('./index')).resolves.toHaveProperty('taskManager')
    } finally {
      vi.doUnmock('./local-task-manager')
    }
  })

  it('is one instance however many copies of the module exist', async () => {
    const manager = new LocalTaskManager()
    await initializeBackgroundWork(manager)
    vi.resetModules()
    const copy = await import('./global')
    expect(copy.taskManager()).toBe(manager)
    expect(copy.isBackgroundWorkInitialized()).toBe(true)
  })

  it('still answers after shutdown, with a manager that ignores what it is given', async () => {
    const manager = new LocalTaskManager()
    await initializeBackgroundWork(manager)
    await stopBackgroundWork()
    expect(taskManager()).toBe(manager)
    await taskManager().cancel('late')
    expect(manager.scheduled()).toEqual([])
  })

  it('releases the services at shutdown', async () => {
    await initializeBackgroundWork(new LocalTaskManager())
    const stop = vi.fn()
    serviceHost().register({ id: 'service', stop })
    await stopBackgroundWork()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('installs stopped after a shutdown that got there first', async () => {
    await stopBackgroundWork()
    expect(isBackgroundWorkInitialized()).toBe(false)

    const manager = new OtherBackend()
    const startDispatch = vi.spyOn(manager, 'start')
    const stopDispatch = vi.spyOn(manager, 'stop')
    await initializeBackgroundWork(manager)
    expect(taskManager()).toBe(manager)
    expect(startDispatch).not.toHaveBeenCalled()
    expect(stopDispatch).toHaveBeenCalledOnce()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const start = vi.fn()
    serviceHost().register({ id: 'late', phase: 'eager', start })
    await serviceHost().start('eager')
    expect(start).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('forgets them on close, for a test to start over', async () => {
    await initializeBackgroundWork(new LocalTaskManager())
    await closeBackgroundWork()
    expect(() => taskManager()).toThrow('Background work is not initialized')
    await closeBackgroundWork()
    await initializeBackgroundWork(new LocalTaskManager())
    expect(isBackgroundWorkInitialized()).toBe(true)
  })

  it('forgets a shutdown on close too', async () => {
    await stopBackgroundWork()
    await closeBackgroundWork()
    const manager = new OtherBackend()
    const start = vi.spyOn(manager, 'start')
    await initializeBackgroundWork(manager)
    expect(start).toHaveBeenCalledOnce()
  })
})
