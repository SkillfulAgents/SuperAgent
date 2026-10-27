import { describe, expect, it, vi } from 'vitest'
import { OrderedSends } from './ordered-sends'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('OrderedSends', () => {
  it('sends in the order the sends were made, whichever read finishes first', async () => {
    const sends = new OrderedSends()
    const sent: string[] = []
    const first = deferred<string>()
    const second = deferred<string>()
    sends.after(first.promise, (value) => sent.push(value))
    sends.after(second.promise, (value) => sent.push(value))

    second.resolve('second')
    await settle()
    expect(sent).toEqual([])

    first.resolve('first')
    await settle()
    expect(sent).toEqual(['first', 'second'])
  })

  it('sends as soon as its own read is done when nothing is ahead of it', async () => {
    const sends = new OrderedSends()
    const sent: number[] = []
    sends.after(Promise.resolve(1), (value) => sent.push(value))
    await settle()
    expect(sent).toEqual([1])
  })

  it('says it drained once the last send made so far has gone, not before', async () => {
    const drained = vi.fn()
    const sends = new OrderedSends(drained)
    const first = deferred<string>()
    sends.after(first.promise, () => {})
    sends.after(Promise.resolve('second'), () => {})
    await settle()
    expect(drained).not.toHaveBeenCalled()

    first.resolve('first')
    await settle()
    expect(drained).toHaveBeenCalledTimes(1)

    sends.after(Promise.resolve('third'), () => {})
    await settle()
    expect(drained).toHaveBeenCalledTimes(2)
  })

  it('does not let a failed send or a failed read hold back the ones after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sends = new OrderedSends()
    const sent: string[] = []
    sends.after(Promise.resolve('a'), () => {
      throw new Error('send failed')
    })
    sends.after(Promise.reject(new Error('read failed')), (value: string) => sent.push(value))
    sends.after(Promise.resolve('c'), (value) => sent.push(value))
    await settle()
    expect(sent).toEqual(['c'])
    vi.restoreAllMocks()
  })
})
