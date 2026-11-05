import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeBackgroundWork,
  initializeBackgroundWork,
  initializeLocalBackgroundWork,
  isBackgroundWorkInitialized,
  serviceHost,
  taskManager,
} from './global'
import { LocalTaskManager } from './local-task-manager'

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

  it('installs local dispatch, already started, before it returns', async () => {
    vi.useFakeTimers()
    try {
      const installing = initializeLocalBackgroundWork()
      expect(isBackgroundWorkInitialized()).toBe(true)
      expect(taskManager()).toBeInstanceOf(LocalTaskManager)
      await installing
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a second initialization', async () => {
    await initializeLocalBackgroundWork()
    await expect(initializeLocalBackgroundWork()).rejects.toThrow('already initialized')
  })

  it('takes any manager, for a backend of its own', async () => {
    const manager = new LocalTaskManager()
    const start = vi.spyOn(manager, 'start')
    await initializeBackgroundWork(manager)
    expect(taskManager()).toBe(manager)
    expect(start).toHaveBeenCalledOnce()
  })

  it('is one instance however many copies of the module exist', async () => {
    await initializeLocalBackgroundWork()
    const manager = taskManager()
    vi.resetModules()
    const copy = await import('./global')
    expect(copy.taskManager()).toBe(manager)
    expect(copy.isBackgroundWorkInitialized()).toBe(true)
  })

  it('still answers after shutdown, with a manager that ignores what it is given', async () => {
    await initializeLocalBackgroundWork()
    const manager = taskManager() as LocalTaskManager
    await serviceHost().stop()
    expect(taskManager()).toBe(manager)
    await taskManager().cancel('late')
    expect(manager.scheduled()).toEqual([])
  })

  it('forgets them on close, for a test to start over', async () => {
    await initializeLocalBackgroundWork()
    await closeBackgroundWork()
    expect(() => taskManager()).toThrow('Background work is not initialized')
    await closeBackgroundWork()
    await initializeLocalBackgroundWork()
    expect(isBackgroundWorkInitialized()).toBe(true)
  })
})
