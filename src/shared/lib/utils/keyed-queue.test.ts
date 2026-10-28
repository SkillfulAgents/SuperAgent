import { describe, expect, it } from 'vitest'
import { serializeByKey } from './keyed-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('serializeByKey', () => {
  it('runs same-key work one after another in arrival order', async () => {
    const log: string[] = []
    const first = deferred<void>()
    const a = serializeByKey('k', async () => {
      log.push('a:start')
      await first.promise
      log.push('a:end')
      return 'a'
    })
    const b = serializeByKey('k', async () => {
      log.push('b:start')
      return 'b'
    })
    await Promise.resolve()
    expect(log).toEqual(['a:start'])

    first.resolve()
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(log).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('lets different keys interleave', async () => {
    const log: string[] = []
    const gate = deferred<void>()
    const slow = serializeByKey('one', async () => {
      await gate.promise
      log.push('one')
    })
    const fast = serializeByKey('two', async () => {
      log.push('two')
    })
    await fast
    expect(log).toEqual(['two'])
    gate.resolve()
    await slow
    expect(log).toEqual(['two', 'one'])
  })

  it('a failure does not fail the work queued behind it', async () => {
    const failing = serializeByKey('k', async () => {
      throw new Error('boom')
    })
    const next = serializeByKey('k', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('ok')
  })

  it('a burst of callers all complete', async () => {
    let running = 0
    let peak = 0
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        serializeByKey('k', async () => {
          running++
          peak = Math.max(peak, running)
          await new Promise((resolve) => setTimeout(resolve, 1))
          running--
          return i
        }),
      ),
    )
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBe(1)
  })
})
