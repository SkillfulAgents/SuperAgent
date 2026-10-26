import { describe, expect, it } from 'vitest'
import { AgentLocks } from './agent-locks'

describe('AgentLocks', () => {
  it('tryAcquire holds a key for one caller at a time; other keys are free', () => {
    const locks = new AgentLocks()
    const token = locks.tryAcquire('wake:t1')
    expect(token).toEqual(expect.any(String))
    expect(locks.tryAcquire('wake:t1')).toBeNull()
    expect(locks.tryAcquire('wake:t2')).not.toBeNull()
    locks.release('wake:t1', token!)
    expect(locks.tryAcquire('wake:t1')).not.toBeNull()
  })

  it('a token that no longer holds the key releases nothing', () => {
    const locks = new AgentLocks()
    const stale = locks.tryAcquire('k')!
    locks.release('k', stale)
    const current = locks.tryAcquire('k')!
    locks.release('k', stale)
    locks.release('k', 'never-issued')
    expect(locks.tryAcquire('k')).toBeNull()
    locks.release('k', current)
    expect(locks.tryAcquire('k')).not.toBeNull()
  })

  it('acquire waits its turn, in the order asked, each holder with a token of its own', async () => {
    const locks = new AgentLocks()
    const first = await locks.acquire('identity')
    const order: string[] = []
    const second = locks.acquire('identity').then((token) => (order.push('second'), token))
    const third = locks.acquire('identity').then((token) => (order.push('third'), token))
    await Promise.resolve()
    expect(order).toEqual([])
    // Waiters queue behind the holder: tryAcquire does not jump them.
    locks.release('identity', first)
    expect(locks.tryAcquire('identity')).toBeNull()

    const secondToken = await second
    expect(order).toEqual(['second'])
    expect(secondToken).not.toBe(first)
    // The first holder's token is spent: it cannot release the second's hold.
    locks.release('identity', first)
    expect(order).toEqual(['second'])

    locks.release('identity', secondToken)
    locks.release('identity', await third)
    expect(order).toEqual(['second', 'third'])
    expect(locks.tryAcquire('identity')).not.toBeNull()
  })

  it('dispose turns every waiter away and lets go of every lock', async () => {
    const locks = new AgentLocks()
    locks.tryAcquire('identity')
    const waiting = locks.acquire('identity')
    locks.dispose()
    await expect(waiting).rejects.toThrow(/no longer held by this process/)
    expect(locks.tryAcquire('identity')).not.toBeNull()
  })
})
