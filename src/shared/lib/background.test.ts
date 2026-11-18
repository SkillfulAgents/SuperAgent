import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setFlagsFromString } from 'v8'
import { runInNewContext } from 'vm'

const captureException = vi.hoisted(() => vi.fn())
vi.mock('./error-reporting', () => ({ captureException }))

import { background, backgroundInFlight, backgroundSettled } from './background'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('background', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    captureException.mockClear()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Failures here are the subject, not a broken run.
    vi.stubEnv('VITEST', '')
  })

  afterEach(async () => {
    await backgroundSettled()
    consoleError.mockRestore()
    vi.unstubAllEnvs()
  })

  it('starts a function at once, as void did', () => {
    const steps: string[] = []
    background(async () => { steps.push('started') }, { name: 'test.start' })
    steps.push('after')
    expect(steps).toEqual(['started', 'after'])
  })

  it('tracks work until it settles', async () => {
    const work = deferred()
    background(work.promise, { name: 'test.tracked' })
    expect(backgroundInFlight()).toEqual(['test.tracked'])

    work.resolve()
    await backgroundSettled()
    expect(backgroundInFlight()).toEqual([])
  })

  it('reports a rejection tagged with its name, and it goes no further', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const error = new Error('boom')
      background(Promise.reject(error), { name: 'test.reject' })
      await backgroundSettled()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(captureException).toHaveBeenCalledWith(error, { tags: { background: 'test.reject' } })
      expect(consoleError).toHaveBeenCalledWith('[background] test.reject failed:', error)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('reports a function that throws before returning a promise', async () => {
    const error = new Error('sync')
    background(() => { throw error }, { name: 'test.sync-throw' })
    await backgroundSettled()
    expect(captureException).toHaveBeenCalledWith(error, { tags: { background: 'test.sync-throw' } })
  })

  it('does not report work that handles its own failure', async () => {
    background(Promise.reject(new Error('handled')).catch(() => {}), { name: 'test.handled' })
    await backgroundSettled()
    expect(captureException).not.toHaveBeenCalled()
  })

  it('waits for work started while it waits', async () => {
    const first = deferred()
    const second = deferred()
    const done: string[] = []
    background(first.promise.then(() => {
      background(second.promise.then(() => { done.push('second') }), { name: 'test.second' })
      done.push('first')
    }), { name: 'test.first' })

    let settled = false
    const settling = backgroundSettled().then(() => { settled = true })
    first.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toEqual(['first'])
    expect(settled).toBe(false)
    expect(backgroundInFlight()).toEqual(['test.second'])

    second.resolve()
    await settling
    expect(done).toEqual(['first', 'second'])
  })

  it('stops waiting for work that can never settle once it is collected', async () => {
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    // Started where nothing keeps it: nothing is left that could resolve it.
    ;(() => background(new Promise<void>(() => {}), { name: 'test.never' }))()

    let settled = false
    const settling = backgroundSettled().then(() => { settled = true })
    for (let attempt = 0; attempt < 50 && !settled; attempt++) {
      gc()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(backgroundInFlight()).toEqual([])
    expect(settled).toBe(true)
    await settling
  })
})
