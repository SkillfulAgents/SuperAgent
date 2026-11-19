import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { LocalTaskManager, type TaskFailureContext } from './local-task-manager'
import { Task, type RetryPolicy, type TaskContext, type TaskResult } from './task'

const payloadSchema = z.object({ n: z.number().optional() })
type Payload = z.infer<typeof payloadSchema>

/** A task that records its runs and answers as each test tells it to. */
class ProbeTask extends Task<Payload> {
  readonly type: string
  readonly payloadSchema = payloadSchema
  readonly retryPolicy?: RetryPolicy
  readonly runs: Array<{ payload: Payload; ctx: TaskContext }> = []
  behaviour: (payload: Payload, ctx: TaskContext) => Promise<TaskResult<Payload>> = async () => ({ kind: 'done' })

  constructor(options: { type?: string; retryPolicy?: RetryPolicy } = {}) {
    super()
    this.type = options.type ?? 'probe'
    this.retryPolicy = options.retryPolicy
  }

  async execute(payload: Payload, ctx: TaskContext): Promise<TaskResult<Payload>> {
    this.runs.push({ payload, ctx })
    return this.behaviour(payload, ctx)
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const spec = (n?: number) => ({ taskType: 'probe', payload: n === undefined ? {} : { n } })

describe('LocalTaskManager', () => {
  let manager: LocalTaskManager
  let task: ProbeTask
  let reported: Array<{ error: unknown; context: TaskFailureContext }>

  const createManager = (random?: () => number) => new LocalTaskManager({
    random,
    report: (error, context) => { reported.push({ error, context }) },
  })

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'))
    reported = []
    manager = createManager()
    task = new ProbeTask()
    manager.register(task)
    await manager.start()
  })

  afterEach(async () => {
    await manager.stop()
    vi.useRealTimers()
  })

  describe('one-off wakeups', () => {
    it('runs at its time and not before, with what it was scheduled with', async () => {
      await manager.at(Date.now() + 5_000, 'job', spec(1))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs).toHaveLength(1)
      expect(task.runs[0].payload).toEqual({ n: 1 })
      expect(task.runs[0].ctx).toMatchObject({ jobId: 'job', attempt: 1 })
      expect(task.runs[0].ctx.signal.aborted).toBe(false)
      expect(manager.scheduled()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('runs a wakeup already due soon after, never inside the call', async () => {
      await manager.at(Date.now() - 60_000, 'job', spec())
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(task.runs).toHaveLength(1)
    })

    it('replaces a pending wakeup with the same id', async () => {
      await manager.at(Date.now() + 1_000, 'job', spec(1))
      await manager.at(Date.now() + 5_000, 'job', spec(2))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs.map(run => run.payload.n)).toEqual([2])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('moves a pending wakeup forward', async () => {
      await manager.at(Date.now() + 60 * 60_000, 'job', spec(1))
      await manager.at(Date.now() + 1_000, 'job', spec(1))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(task.runs).toHaveLength(1)
    })

    it('keeps jobs with different ids apart', async () => {
      await manager.at(Date.now() + 1_000, 'a', spec(1))
      await manager.at(Date.now() + 2_000, 'b', spec(2))
      await manager.cancel('a')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(task.runs.map(run => run.payload.n)).toEqual([2])
    })

    it('cancels a pending wakeup, and ignores an unknown id', async () => {
      await manager.at(Date.now() + 1_000, 'job', spec())
      await manager.cancel('job')
      await manager.cancel('nothing')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('refuses a time that is not a number', async () => {
      await expect(manager.at(Number.NaN, 'job', spec())).rejects.toThrow('invalid time')
      expect(manager.scheduled()).toEqual([])
    })
  })

  describe('the clock and long waits', () => {
    it('does not fire early past the limit of setTimeout', async () => {
      const warnings = vi.spyOn(process, 'emitWarning')
      const in60Days = Date.now() + 60 * 24 * 60 * 60_000
      await manager.at(in60Days, 'far', spec())
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(59 * 24 * 60 * 60_000)
      expect(task.runs).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
      expect(task.runs).toHaveLength(1)
      expect(warnings).not.toHaveBeenCalled()
      warnings.mockRestore()
    })

    // Process timers stop while the machine sleeps and the wall clock does not.
    // The fake clock jumping with no timer time passing is that sleep.
    it('runs a wakeup that came due during a sleep within a minute of waking', async () => {
      await manager.at(Date.now() + 60 * 60_000, 'job', spec())
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs).toHaveLength(1)
    })

    it('does not run a wakeup whose timer fires before its time by the clock', async () => {
      await manager.at(Date.now() + 1_000, 'job', spec())
      vi.setSystemTime(Date.now() - 30_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(task.runs).toHaveLength(1)
    })

    it('waits like an interval on a recurring job, with no regard for the clock', async () => {
      await manager.ensureEvery('job', spec(), { intervalMs: 60 * 60_000 })
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
      await vi.advanceTimersByTimeAsync(59 * 60_000)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(task.runs).toHaveLength(1)
    })
  })

  describe('recurring jobs', () => {
    it('makes its first pass after the initial delay, then one per interval', async () => {
      await manager.ensureEvery('job', spec(), { intervalMs: 60_000, initialDelayMs: 10_000 })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(task.runs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(60_000 * 3)
      expect(task.runs).toHaveLength(5)
    })

    it('waits one interval before the first pass by default, as an interval timer does', async () => {
      await manager.ensureEvery('job', spec(), { intervalMs: 60_000 })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs).toHaveLength(1)
    })

    it('starts each pass a fresh occurrence', async () => {
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(task.runs.map(run => run.ctx.attempt)).toEqual([1, 1])
      expect(task.runs[0].ctx.executionId).not.toBe(task.runs[1].ctx.executionId)
    })

    it('keeps one job per id, whatever a second call asks for', async () => {
      await manager.ensureEvery('job', spec(1), { intervalMs: 60_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      await manager.ensureEvery('job', spec(2), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(task.runs.map(run => run.payload.n)).toEqual([1])
      expect(manager.scheduled()).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)
    })

    it('skips a pass that comes due while the last one runs, and keeps its cadence', async () => {
      const gate = deferred()
      task.behaviour = async () => { await gate.promise; return { kind: 'done' } }
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(3_500)
      expect(task.runs).toHaveLength(1)
      expect(manager.scheduled()[0].running).toBe(true)

      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(task.runs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(task.runs).toHaveLength(2)
    })

    it('stops when cancelled, before its first pass or after one', async () => {
      await manager.ensureEvery('early', spec(), { intervalMs: 1_000, initialDelayMs: 5_000 })
      await manager.ensureEvery('late', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      await manager.cancel('early')
      await manager.cancel('late')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('can be scheduled again once cancelled', async () => {
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await manager.cancel('job')
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs).toHaveLength(1)
    })

    it('varies each wait by up to its jitter', async () => {
      await manager.stop()
      manager = createManager(() => 1)
      manager.register(task)
      await manager.start()
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000, jitterRatio: 0.5 })
      await vi.advanceTimersByTimeAsync(1_499)
      expect(task.runs).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs).toHaveLength(1)
    })

    it('reports a next occurrence as a misuse and keeps its cadence', async () => {
      task.behaviour = async () => ({ kind: 'next', at: Date.now() + 1, payload: {} })
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(reported[0].error).toMatchObject({ message: expect.stringContaining('returned a next occurrence') })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs).toHaveLength(2)
    })

    it('replaces a one-off under the same id', async () => {
      await manager.at(Date.now() + 1_000, 'job', spec(1))
      await manager.ensureEvery('job', spec(2), { intervalMs: 5_000 })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(task.runs.map(run => run.payload.n)).toEqual([2])
    })
  })

  describe('task results', () => {
    it('retries the same occurrence when asked to', async () => {
      let answers = 0
      task.behaviour = async (_payload, ctx) => (++answers < 3 ? { kind: 'retry', at: ctx.now() + 1_000, reason: 'busy' } : { kind: 'done' })
      await manager.at(Date.now(), 'job', spec(1))
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.scheduled()[0]).toMatchObject({ attempt: 1 })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(task.runs.map(run => run.ctx.attempt)).toEqual([1, 2, 3])
      expect(new Set(task.runs.map(run => run.ctx.executionId)).size).toBe(1)
      expect(task.runs.every(run => run.payload.n === 1)).toBe(true)
      expect(manager.scheduled()).toEqual([])
    })

    it('schedules the next occurrence fresh, with its payload', async () => {
      let answers = 0
      task.behaviour = async (_payload, ctx) => (++answers === 1 ? { kind: 'next', at: ctx.now() + 1_000, payload: { n: 2 } } : { kind: 'done' })
      await manager.at(Date.now(), 'job', spec(1))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs.map(run => [run.payload.n, run.ctx.attempt])).toEqual([[1, 1], [2, 1]])
      expect(task.runs[0].ctx.executionId).not.toBe(task.runs[1].ctx.executionId)
    })

    it('reports a next occurrence with an invalid payload or time, and ends the job', async () => {
      task.behaviour = async (_payload, ctx) => ({ kind: 'next', at: ctx.now() + 1_000, payload: { n: 'two' } as unknown as Payload })
      await manager.at(Date.now(), 'bad-payload', spec())
      await vi.advanceTimersByTimeAsync(0)
      expect(reported).toHaveLength(1)
      expect(manager.scheduled()).toEqual([])

      task.behaviour = async () => ({ kind: 'next', at: Number.NaN, payload: {} })
      await manager.at(Date.now(), 'bad-time', spec())
      await vi.advanceTimersByTimeAsync(0)
      expect(reported).toHaveLength(2)
      expect(manager.scheduled()).toEqual([])
    })

    it('retries a recurring job on its own time, and the next pass takes over from a retry still waiting', async () => {
      task.behaviour = async (_payload, ctx) => (ctx.attempt === 1 ? { kind: 'retry', at: ctx.now() + 400 } : { kind: 'done' })
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(400)
      expect(task.runs.map(run => run.ctx.attempt)).toEqual([1, 2])
      // The cadence did not move.
      await vi.advanceTimersByTimeAsync(600)
      expect(task.runs).toHaveLength(3)

      task.behaviour = async (_payload, ctx) => ({ kind: 'retry', at: ctx.now() + 5_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs.at(-1)?.ctx.attempt).toBe(1)
      expect(vi.getTimerCount()).toBe(2)
    })
  })

  describe('failures', () => {
    it('reports a failure and ends a one-off with no retry policy', async () => {
      task.behaviour = async () => { throw new Error('boom') }
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      expect(reported).toEqual([{ error: expect.objectContaining({ message: 'boom' }), context: { taskType: 'probe', jobId: 'job', attempt: 1 } }])
      expect(manager.scheduled()).toEqual([])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(task.runs).toHaveLength(1)
    })

    it('keeps a recurring job going after a failed pass', async () => {
      task.behaviour = async () => { throw new Error('boom') }
      await manager.ensureEvery('job', spec(), { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(task.runs).toHaveLength(3)
      expect(reported).toHaveLength(3)
      expect(task.runs.map(run => run.ctx.attempt)).toEqual([1, 1, 1])
    })

    it('survives a task that throws before it returns a promise', async () => {
      class SyncThrow extends ProbeTask {
        override execute(): Promise<TaskResult<Payload>> { throw new Error('sync boom') }
      }
      manager.register(new SyncThrow({ type: 'sync-throw' }))
      await manager.at(Date.now(), 'job', { taskType: 'sync-throw', payload: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(reported[0].error).toMatchObject({ message: 'sync boom' })
    })

    it('follows the retry policy, keeps one execution id, then reports and gives up', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const retrying = new ProbeTask({ type: 'retrying', retryPolicy: { delaysMs: [1_000, 5_000, 30_000] } })
      retrying.behaviour = async () => { throw new Error('boom') }
      manager.register(retrying)
      await manager.at(Date.now(), 'job', { taskType: 'retrying', payload: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(retrying.runs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(retrying.runs).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(retrying.runs).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(retrying.runs).toHaveLength(3)
      expect(reported).toEqual([])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(retrying.runs).toHaveLength(4)
      expect(new Set(retrying.runs.map(run => run.ctx.executionId)).size).toBe(1)
      expect(reported).toHaveLength(1)
      expect(reported[0].context.attempt).toBe(4)
      expect(manager.scheduled()).toEqual([])
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(retrying.runs).toHaveLength(4)
      warn.mockRestore()
    })

    it('repeats the last delay up to maxAttempts', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const retrying = new ProbeTask({ type: 'retrying', retryPolicy: { delaysMs: [1_000], maxAttempts: 4 } })
      retrying.behaviour = async () => { throw new Error('boom') }
      manager.register(retrying)
      await manager.at(Date.now(), 'job', { taskType: 'retrying', payload: {} })
      await vi.advanceTimersByTimeAsync(3_000)
      expect(retrying.runs).toHaveLength(4)
      expect(reported).toHaveLength(1)
      warn.mockRestore()
    })

    it('gives a recurring pass its retries, then waits for the next pass', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const retrying = new ProbeTask({ type: 'retrying', retryPolicy: { delaysMs: [100] } })
      retrying.behaviour = async () => { throw new Error('boom') }
      manager.register(retrying)
      await manager.ensureEvery('job', { taskType: 'retrying', payload: {} }, { intervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(retrying.runs.map(run => run.ctx.attempt)).toEqual([1, 2])
      expect(reported).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(900)
      expect(retrying.runs.map(run => run.ctx.attempt)).toEqual([1, 2, 1])
      warn.mockRestore()
    })
  })

  describe('registration and payloads', () => {
    it('refuses work for a task type nobody registered', async () => {
      await expect(manager.at(Date.now(), 'job', { taskType: 'nope', payload: {} })).rejects.toThrow('No task is registered for type nope')
      await expect(manager.ensureEvery('job', { taskType: 'nope', payload: {} }, { intervalMs: 1_000 })).rejects.toThrow('No task is registered')
      expect(manager.scheduled()).toEqual([])
    })

    it('answers which task types it handles', () => {
      expect(manager.handles('probe')).toBe(true)
      expect(manager.handles('nope')).toBe(false)
    })

    it('refuses a payload its schema refuses', async () => {
      await expect(manager.at(Date.now(), 'job', { taskType: 'probe', payload: { n: 'one' } })).rejects.toThrow()
      expect(manager.scheduled()).toEqual([])
    })

    // A later backend stores payloads, so a payload that would not survive that fails here too.
    it('refuses a payload that would not survive being stored', async () => {
      const dated = new (class extends ProbeTask {
        override readonly payloadSchema = z.object({ when: z.date() }) as unknown as typeof payloadSchema
      })({ type: 'dated' })
      manager.register(dated)
      await expect(manager.at(Date.now(), 'job', { taskType: 'dated', payload: { when: new Date() } })).rejects.toThrow()
    })

    it('gives a task its own copy of the payload', async () => {
      const payload = { n: 1 }
      await manager.at(Date.now() + 1_000, 'job', { taskType: 'probe', payload })
      payload.n = 2
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs[0].payload).toEqual({ n: 1 })
    })

    it('uses the newest handler registered for a type', async () => {
      await manager.at(Date.now() + 1_000, 'job', spec())
      const newer = new ProbeTask()
      manager.register(newer)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs).toHaveLength(0)
      expect(newer.runs).toHaveLength(1)
    })
  })

  describe('replacing and cancelling around a run', () => {
    it('ignores what a cancelled run comes back with', async () => {
      const gate = deferred<TaskResult<Payload>>()
      task.behaviour = () => gate.promise
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      await manager.cancel('job')
      expect(task.runs[0].ctx.signal.aborted).toBe(true)

      gate.resolve({ kind: 'next', at: Date.now() + 1_000, payload: {} })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(1)
      expect(manager.scheduled()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not rearm a cancelled job from a retry', async () => {
      const gate = deferred<TaskResult<Payload>>()
      task.behaviour = () => gate.promise
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      await manager.cancel('job')
      gate.resolve({ kind: 'retry', at: Date.now() + 1_000 })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not report the failure of a cancelled run', async () => {
      const gate = deferred<TaskResult<Payload>>()
      task.behaviour = () => gate.promise
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      await manager.cancel('job')
      gate.reject(new Error('aborted'))
      await vi.advanceTimersByTimeAsync(0)
      expect(reported).toEqual([])
    })

    it('keeps a replacement when the replaced run comes back', async () => {
      const gate = deferred<TaskResult<Payload>>()
      task.behaviour = () => gate.promise
      await manager.at(Date.now(), 'job', spec(1))
      await vi.advanceTimersByTimeAsync(0)

      await manager.at(Date.now() + 5_000, 'job', spec(2))
      // A replaced run is superseded, not told to stop.
      expect(task.runs[0].ctx.signal.aborted).toBe(false)
      task.behaviour = async () => ({ kind: 'done' })
      gate.resolve({ kind: 'done' })
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.scheduled()).toMatchObject([{ id: 'job' }])

      await vi.advanceTimersByTimeAsync(5_000)
      expect(task.runs.map(run => run.payload.n)).toEqual([1, 2])
      expect(manager.scheduled()).toEqual([])
    })

    it('does not let a replaced run overwrite its replacement with a retry or a next', async () => {
      const first = deferred<TaskResult<Payload>>()
      const second = deferred<TaskResult<Payload>>()
      task.behaviour = () => first.promise
      await manager.at(Date.now(), 'a', spec(1))
      await manager.at(Date.now(), 'b', spec(2))
      await vi.advanceTimersByTimeAsync(0)
      task.behaviour = async () => ({ kind: 'done' })
      await manager.at(Date.now() + 5_000, 'a', spec(3))
      await manager.at(Date.now() + 5_000, 'b', spec(4))
      first.resolve({ kind: 'retry', at: Date.now() + 1 })
      second.resolve({ kind: 'next', at: Date.now() + 1, payload: { n: 9 } })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(task.runs).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(task.runs.map(run => run.payload.n).sort()).toEqual([1, 2, 3, 4])
    })

    it('holds a replacement that comes due until the run before it has settled', async () => {
      const gate = deferred<TaskResult<Payload>>()
      task.behaviour = () => gate.promise
      await manager.at(Date.now(), 'job', spec(1))
      await vi.advanceTimersByTimeAsync(0)
      await manager.at(Date.now() + 1_000, 'job', spec(2))
      task.behaviour = async () => ({ kind: 'done' })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(1)
      gate.resolve({ kind: 'done' })
      await vi.advanceTimersByTimeAsync(0)
      expect(task.runs.map(run => run.payload.n)).toEqual([1, 2])
    })

    it('does not run a replacement that was cancelled while it waited on the run before it', async () => {
      const gate = deferred<TaskResult<Payload>>()
      task.behaviour = () => gate.promise
      await manager.at(Date.now(), 'job', spec(1))
      await vi.advanceTimersByTimeAsync(0)
      await manager.at(Date.now() + 1_000, 'job', spec(2))
      await vi.advanceTimersByTimeAsync(1_000)
      await manager.cancel('job')
      gate.resolve({ kind: 'done' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(1)
    })

    it('lets a task reschedule itself from inside its own run', async () => {
      task.behaviour = async (payload, ctx) => {
        if (payload.n === 1) await manager.at(ctx.now() + 1_000, 'job', spec(2))
        return { kind: 'done' }
      }
      await manager.at(Date.now(), 'job', spec(1))
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.scheduled()).toMatchObject([{ id: 'job' }])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(task.runs.map(run => run.payload.n)).toEqual([1, 2])
      expect(manager.scheduled()).toEqual([])
    })
  })

  describe('start and stop', () => {
    it('sets no timer and does nothing until there is work', () => {
      expect(new LocalTaskManager().scheduled()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('holds work scheduled before start, then dispatches it', async () => {
      const idle = createManager()
      idle.register(task)
      await idle.at(Date.now() + 1_000, 'once', spec(1))
      await idle.ensureEvery('every', spec(2), { intervalMs: 5_000, initialDelayMs: 2_000 })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(0)

      await idle.start()
      await vi.advanceTimersByTimeAsync(0)
      // The wakeup's time has passed; the recurring job counts from dispatch starting.
      expect(task.runs.map(run => run.payload.n)).toEqual([1])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(task.runs.map(run => run.payload.n)).toEqual([1, 2])
      await idle.stop()
    })

    it('clears every timer on stop and runs nothing after it', async () => {
      await manager.at(Date.now() + 1_000, 'once', spec())
      await manager.ensureEvery('every', spec(), { intervalMs: 1_000 })
      await manager.stop()
      expect(vi.getTimerCount()).toBe(0)
      expect(manager.scheduled()).toEqual([])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(0)
    })

    it('does not resurrect anything from a run still in flight at stop', async () => {
      const once = deferred<TaskResult<Payload>>()
      const every = deferred<TaskResult<Payload>>()
      const retrying = deferred<TaskResult<Payload>>()
      const answers = [once, every, retrying]
      task.behaviour = () => answers.shift()!.promise
      await manager.at(Date.now(), 'once', spec())
      await manager.ensureEvery('every', spec(), { intervalMs: 1, initialDelayMs: 0 })
      await manager.at(Date.now(), 'retrying', spec())
      await vi.advanceTimersByTimeAsync(0)
      expect(task.runs).toHaveLength(3)

      await manager.stop()
      expect(task.runs.every(run => run.ctx.signal.aborted)).toBe(true)
      once.resolve({ kind: 'next', at: Date.now() + 1, payload: {} })
      every.resolve({ kind: 'done' })
      retrying.resolve({ kind: 'retry', at: Date.now() + 1 })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(3)
      expect(manager.scheduled()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('ignores work scheduled after stop, as a late callback would', async () => {
      await manager.stop()
      await manager.at(Date.now(), 'once', spec())
      await manager.ensureEvery('every', spec(), { intervalMs: 1_000 })
      expect(manager.scheduled()).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(task.runs).toHaveLength(0)
    })

    it('resolves stop without waiting for a run that never settles', async () => {
      task.behaviour = () => new Promise(() => {})
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      await expect(manager.stop()).resolves.toBeUndefined()
    })

    it('starts a new manager with nothing scheduled and no retry state', async () => {
      task.behaviour = async (_payload, ctx) => ({ kind: 'retry', at: ctx.now() + 1_000 })
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(2_000)
      expect(task.runs).toHaveLength(3)

      const fresh = createManager()
      expect(fresh.scheduled()).toEqual([])
      expect(fresh.taskStats()).toEqual([])
      fresh.register(task)
      await fresh.start()
      await fresh.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      expect(task.runs.at(-1)?.ctx.attempt).toBe(1)
      await fresh.stop()
    })
  })

  describe('scope and diagnostics', () => {
    it('runs a task outside the scope of whoever scheduled it', async () => {
      const scope = new AsyncLocalStorage<string>()
      let seen: string | undefined = 'unset'
      task.behaviour = async () => {
        seen = scope.getStore()
        return { kind: 'done' }
      }
      await scope.run('alice', () => manager.at(Date.now() + 1_000, 'job', spec()))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(seen).toBeUndefined()

      seen = 'unset'
      await scope.run('alice', () => manager.ensureEvery('every', spec(), { intervalMs: 1_000 }))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(seen).toBeUndefined()
    })

    it('keeps what a task can do with its scope to itself across a retry', async () => {
      const scope = new AsyncLocalStorage<string>()
      const seen: Array<string | undefined> = []
      task.behaviour = async (_payload, ctx) => {
        seen.push(scope.getStore())
        if (ctx.attempt > 1) return { kind: 'done' }
        return scope.run('task-run', async () => ({ kind: 'retry', at: ctx.now() + 1 }))
      }
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(10)
      expect(seen).toEqual([undefined, undefined])
    })

    it('records the last run and error of each task type', async () => {
      task.behaviour = async () => { throw new Error('boom') }
      await manager.at(Date.now(), 'job', spec())
      await vi.advanceTimersByTimeAsync(0)
      expect(manager.taskStats()).toEqual([{ taskType: 'probe', runs: 1, failures: 1, lastRunAt: Date.now(), lastError: 'boom' }])
    })

    it('reports what is scheduled and when', async () => {
      const dueAt = Date.now() + 1_000
      await manager.at(dueAt, 'once', spec())
      await manager.ensureEvery('every', spec(), { intervalMs: 2_000 })
      expect(manager.scheduled()).toEqual([
        { id: 'once', taskType: 'probe', recurring: false, nextRunAt: dueAt, running: false, attempt: 0 },
        { id: 'every', taskType: 'probe', recurring: true, nextRunAt: dueAt + 1_000, running: false, attempt: 0 },
      ])
    })
  })
})
