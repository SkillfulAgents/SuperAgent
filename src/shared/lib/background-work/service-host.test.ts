import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { LocalTaskManager } from './local-task-manager'
import { ServiceHost, type Service } from './service-host'
import { Task, type TaskResult } from './task'

class NoopTask extends Task<Record<string, never>> {
  readonly payloadSchema = z.object({}).strict() as z.ZodType<Record<string, never>>
  constructor(readonly type: string) { super() }
  async execute(): Promise<TaskResult<Record<string, never>>> { return { kind: 'done' } }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('ServiceHost', () => {
  let manager: LocalTaskManager
  let host: ServiceHost
  let events: string[]
  let errors: ReturnType<typeof vi.spyOn>

  /** A service that records its hooks; `overrides` replaces any of them. */
  const service = (id: string, overrides: Partial<Service> = {}): Service => ({
    id,
    phase: 'background',
    start: () => { events.push(`start:${id}`) },
    stop: () => { events.push(`stop:${id}`) },
    ...overrides,
  })

  beforeEach(async () => {
    events = []
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    manager = new LocalTaskManager({ report: () => {} })
    await manager.start()
    host = new ServiceHost(manager)
  })

  afterEach(async () => {
    await host.stop()
    vi.restoreAllMocks()
  })

  describe('registration', () => {
    it('registers a service and its tasks, and starts nothing', () => {
      host.register(service('a', { tasks: [new NoopTask('a.sync')] }))
      expect(events).toEqual([])
      expect(host.isRegistered('a')).toBe(true)
      expect(host.states()).toEqual({ a: 'registered' })
      expect(manager.handles('a.sync')).toBe(true)
      expect(manager.scheduled()).toEqual([])
    })

    it('refuses a second service with the same id', () => {
      host.register(service('a'))
      expect(() => host.register(service('a'))).toThrow('already registered')
    })

    it('ignores a registration after it has stopped', async () => {
      await host.stop()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      host.register(service('late', { tasks: [new NoopTask('late.sync')] }))
      expect(host.isRegistered('late')).toBe(false)
      expect(manager.handles('late.sync')).toBe(false)
      expect(warn).toHaveBeenCalledOnce()
    })
  })

  describe('phases', () => {
    it('starts only the services of the phase', async () => {
      host.register(service('eager', { phase: 'eager' }))
      host.register(service('background'))
      host.register(service('no-phase', { phase: undefined }))
      await host.start('eager')
      expect(events).toEqual(['start:eager'])
      await host.start('background')
      expect(events).toEqual(['start:eager', 'start:background'])
    })

    it('starts the eager phase one at a time, in registration order', async () => {
      const first = deferred()
      host.register(service('first', { phase: 'eager', start: async () => { events.push('start:first'); await first.promise; events.push('end:first') } }))
      host.register(service('second', { phase: 'eager' }))
      const starting = host.start('eager')
      await vi.waitFor(() => expect(events).toEqual(['start:first']))
      first.resolve()
      await starting
      expect(events).toEqual(['start:first', 'end:first', 'start:second'])
    })

    it('starts the background phase without one service waiting on another', async () => {
      const slow = deferred()
      host.register(service('slow', { start: () => slow.promise }))
      host.register(service('quick'))
      const starting = host.start('background')
      await vi.waitFor(() => expect(events).toEqual(['start:quick']))
      slow.resolve()
      await starting
      expect(host.states()).toEqual({ slow: 'started', quick: 'started' })
    })

    it('starts a service once, across phases and direct starts', async () => {
      host.register(service('a'))
      await host.start('background')
      await host.start('background')
      await host.startService('a')
      expect(events).toEqual(['start:a'])
    })

    it('starts a service with no phase when its owner says so', async () => {
      host.register(service('owned', { phase: undefined }))
      await host.start('eager')
      await host.start('background')
      expect(events).toEqual([])
      await host.startService('owned')
      expect(events).toEqual(['start:owned'])
      await expect(host.startService('nope')).rejects.toThrow('not registered')
    })

    it('tolerates a service with no hooks', async () => {
      host.register({ id: 'bare', phase: 'background' })
      await host.start('background')
      expect(host.states()).toEqual({ bare: 'started' })
    })
  })

  describe('startup I/O lanes', () => {
    it('bounds startup I/O in registration order, and leaves the rest of the phase free', async () => {
      const gates = new Map<string, ReturnType<typeof deferred>>()
      const lane = (id: string) => {
        gates.set(id, deferred())
        return service(id, {
          startupIo: true,
          start: async () => {
            events.push(`start:${id}`)
            await gates.get(id)!.promise
          },
        })
      }
      host = new ServiceHost(manager, { startupIoConcurrency: 2 })
      host.register(lane('a'))
      host.register(lane('b'))
      host.register(service('free'))
      host.register(lane('c'))
      host.register(lane('d'))

      const starting = host.start('background')
      await vi.waitFor(() => expect([...events].sort()).toEqual(['start:a', 'start:b', 'start:free']))

      gates.get('b')!.resolve()
      await vi.waitFor(() => expect(events).toContain('start:c'))
      expect(events).not.toContain('start:d')

      gates.get('a')!.resolve()
      await vi.waitFor(() => expect(events).toContain('start:d'))
      gates.get('c')!.resolve()
      gates.get('d')!.resolve()
      await starting
    })

    it('frees the slot of a failed start', async () => {
      host = new ServiceHost(manager, { startupIoConcurrency: 1 })
      host.register(service('fails', { startupIo: true, start: async () => { throw new Error('boom') } }))
      host.register(service('next', { startupIo: true }))
      await host.start('background')
      expect(events).toEqual(['start:next'])
    })

    it('skips a start still queued for a slot once the host stops, and stops the one in flight again when it settles', async () => {
      const inFlight = deferred()
      host = new ServiceHost(manager, { startupIoConcurrency: 1 })
      host.register(service('running', {
        startupIo: true,
        start: async () => {
          events.push('start:running')
          await inFlight.promise
          events.push('end:running')
        },
      }))
      host.register(service('queued', { startupIo: true }))
      const starting = host.start('background')
      await vi.waitFor(() => expect(events).toEqual(['start:running']))

      await host.stop()
      expect(events).toEqual(['start:running', 'stop:queued', 'stop:running'])

      inFlight.resolve()
      await starting
      // Only what actually began gets the second stop.
      expect(events).toEqual(['start:running', 'stop:queued', 'stop:running', 'end:running', 'stop:running'])
    })
  })

  describe('enablement', () => {
    it('does not start a disabled service, sync or async', async () => {
      host.register(service('off', { enabled: () => false }))
      host.register(service('off-async', { enabled: async () => false }))
      host.register(service('on', { enabled: async () => true }))
      await host.start('background')
      expect(events).toEqual(['start:on'])
      expect(host.states()).toEqual({ 'off': 'disabled', 'off-async': 'disabled', 'on': 'started' })
    })

    it('treats a failed enablement check as a failed start', async () => {
      host.register(service('broken', { enabled: async () => { throw new Error('no settings') } }))
      await host.start('background')
      expect(host.states()).toEqual({ broken: 'failed' })
      expect(errors).toHaveBeenCalledWith('[ServiceHost] Failed to start broken:', expect.objectContaining({ message: 'no settings' }))
    })

    it('does not start a service whose check finished after the host stopped', async () => {
      const check = deferred()
      host.register(service('racing', { enabled: async () => { await check.promise; return true } }))
      const starting = host.start('background')
      await host.stop()
      check.resolve()
      await starting
      expect(events).not.toContain('start:racing')
    })
  })

  describe('startup failures', () => {
    it('logs a noncritical failure and goes on', async () => {
      host.register(service('fails', { phase: 'eager', start: async () => { throw new Error('boom') } }))
      host.register(service('next', { phase: 'eager' }))
      await expect(host.start('eager')).resolves.toBeUndefined()
      expect(events).toEqual(['start:next'])
      expect(host.states()).toEqual({ fails: 'failed', next: 'started' })
      expect(errors).toHaveBeenCalledWith('[ServiceHost] Failed to start fails:', expect.objectContaining({ message: 'boom' }))
    })

    it('fails the eager phase on a critical failure, and starts nothing after it', async () => {
      host.register(service('before', { phase: 'eager' }))
      host.register(service('critical', { phase: 'eager', critical: true, start: async () => { throw new Error('containers') } }))
      host.register(service('after', { phase: 'eager' }))
      await expect(host.start('eager')).rejects.toThrow('containers')
      expect(events).toEqual(['start:before'])
      expect(host.states()).toEqual({ before: 'started', critical: 'failed', after: 'registered' })
    })

    it('fails on a synchronous throw from a start hook just the same', async () => {
      host.register(service('critical', { phase: 'eager', critical: true, start: () => { throw new Error('sync') } }))
      await expect(host.start('eager')).rejects.toThrow('sync')
    })

    it('rejects the background phase on a critical failure while the rest still start', async () => {
      const gate = deferred()
      host.register(service('critical', { critical: true, start: async () => { throw new Error('boom') } }))
      host.register(service('other', { start: async () => { await gate.promise; events.push('start:other') } }))
      await expect(host.start('background')).rejects.toThrow('boom')
      gate.resolve()
      await vi.waitFor(() => expect(events).toEqual(['start:other']))
    })
  })

  describe('stopping', () => {
    it('stops dispatch first, then services last registered first', async () => {
      const order: string[] = []
      const stop = vi.spyOn(manager, 'stop').mockImplementation(async () => { order.push('dispatch') })
      for (const id of ['a', 'b', 'c']) host.register(service(id, { stop: () => { order.push(id) } }))
      await host.start('background')
      await host.stop()
      expect(order).toEqual(['dispatch', 'c', 'b', 'a'])
      stop.mockRestore()
    })

    it('waits for each service before the one before it', async () => {
      const gate = deferred()
      host.register(service('dependency', { stop: () => { events.push('stop:dependency') } }))
      host.register(service('dependent', { stop: async () => { events.push('stopping:dependent'); await gate.promise; events.push('stopped:dependent') } }))
      const stopping = host.stop()
      await vi.waitFor(() => expect(events).toEqual(['stopping:dependent']))
      gate.resolve()
      await stopping
      expect(events).toEqual(['stopping:dependent', 'stopped:dependent', 'stop:dependency'])
    })

    it('goes on past a service that fails to stop', async () => {
      host.register(service('a'))
      host.register(service('fails', { stop: async () => { throw new Error('stuck') } }))
      host.register(service('sync-fails', { stop: () => { throw new Error('stuck too') } }))
      await expect(host.stop()).resolves.toBeUndefined()
      expect(events).toEqual(['stop:a'])
      expect(errors).toHaveBeenCalledWith('[ServiceHost] Failed to stop fails:', expect.objectContaining({ message: 'stuck' }))
      expect(errors).toHaveBeenCalledWith('[ServiceHost] Failed to stop sync-fails:', expect.objectContaining({ message: 'stuck too' }))
    })

    it('goes on when dispatch fails to stop', async () => {
      vi.spyOn(manager, 'stop').mockRejectedValue(new Error('dispatch stuck'))
      host.register(service('a'))
      await host.stop()
      expect(events).toEqual(['stop:a'])
    })

    it('stops a service that never started, so it can release what it holds lazily', async () => {
      host.register({ id: 'stop-only', stop: () => { events.push('stop:stop-only') } })
      host.register(service('never-started'))
      host.register(service('disabled', { enabled: () => false }))
      await host.stop()
      expect(events).toEqual(['stop:disabled', 'stop:never-started', 'stop:stop-only'])
    })

    it('stops what started and what did not after a partial start', async () => {
      host.register(service('started', { phase: 'eager' }))
      host.register(service('failed', { phase: 'eager', critical: true, start: async () => { throw new Error('boom') } }))
      host.register(service('skipped', { phase: 'eager' }))
      await expect(host.start('eager')).rejects.toThrow('boom')
      await host.stop()
      expect(events).toEqual(['start:started', 'stop:skipped', 'stop:failed', 'stop:started'])
    })

    it('stops once for any number of calls, and every caller waits for it', async () => {
      const gate = deferred()
      host.register(service('a', { stop: async () => { events.push('stop:a'); await gate.promise } }))
      const first = host.stop()
      const second = host.stop()
      let secondDone = false
      void second.then(() => { secondDone = true })
      await vi.waitFor(() => expect(events).toEqual(['stop:a']))
      expect(secondDone).toBe(false)
      gate.resolve()
      await Promise.all([first, second])
      expect(events).toEqual(['stop:a'])
    })

    it('starts nothing after it has stopped', async () => {
      host.register(service('eager', { phase: 'eager' }))
      host.register(service('background'))
      host.register(service('owned', { phase: undefined }))
      await host.stop()
      events.length = 0
      await host.start('eager')
      await host.start('background')
      await host.startService('owned')
      expect(events).toEqual([])
    })

    it('stops a service again when its start settles after the stop, success or failure', async () => {
      const ok = deferred()
      const bad = deferred()
      host.register(service('ok', { start: () => ok.promise }))
      host.register(service('bad', { start: () => bad.promise }))
      const starting = host.start('background')
      await host.stop()
      expect(events).toEqual(['stop:bad', 'stop:ok'])
      ok.resolve()
      bad.reject(new Error('late failure'))
      await starting
      expect(events).toEqual(['stop:bad', 'stop:ok', 'stop:ok', 'stop:bad'])
    })

    it('does not wait for a start in flight, so one that never settles cannot hold up shutdown', async () => {
      host.register(service('forever', { start: () => new Promise<void>(() => {}) }))
      void host.start('background')
      await expect(host.stop()).resolves.toBeUndefined()
      expect(events).toEqual(['stop:forever'])
    })

    it('has dispatch stopped by the time the first service lets go', async () => {
      class Probe extends NoopTask {
        runs = 0
        override async execute(): Promise<TaskResult<Record<string, never>>> { this.runs += 1; return { kind: 'done' } }
      }
      const task = new Probe('probe')
      host.register(service('a', {
        tasks: [task],
        stop: async () => {
          expect(manager.scheduled()).toEqual([])
          // A late callback scheduling work here has nothing to resurrect.
          await manager.at(Date.now(), 'late', { taskType: 'probe', payload: {} })
        },
      }))
      await manager.ensureEvery('job', { taskType: 'probe', payload: {} }, { intervalMs: 1 })
      await host.stop()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(task.runs).toBe(0)
      expect(manager.scheduled()).toEqual([])
    })
  })
})
