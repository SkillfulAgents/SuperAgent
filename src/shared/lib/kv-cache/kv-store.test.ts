import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryKVStore } from './kv-store'

afterEach(() => {
  vi.useRealTimers()
})

describe('InMemoryKVStore', () => {
  it('returns a copy of the stored value, so changing what was read leaves the entry as stored', async () => {
    const store = new InMemoryKVStore()
    await store.put('oidc-jwks:https://auth.example.com', { keys: [{ kid: 'main' }] })

    const read = await store.get<{ keys: { kid: string }[] }>('oidc-jwks:https://auth.example.com')
    read!.keys.push({ kid: 'added-by-caller' })

    expect(await store.get('oidc-jwks:https://auth.example.com')).toEqual({ keys: [{ kid: 'main' }] })
  })

  it('serves an entry until its TTL ends, then returns null', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T12:00:00Z') })
    const store = new InMemoryKVStore()
    await store.put('agent-row:a1b2c3d4e5', { name: 'Sales' }, 2_000)

    vi.advanceTimersByTime(1_999)
    expect(await store.get('agent-row:a1b2c3d4e5')).toEqual({ name: 'Sales' })

    vi.advanceTimersByTime(1)
    expect(await store.get('agent-row:a1b2c3d4e5')).toBeNull()
  })

  it('reads and deletes several keys at once, with null for a missing key', async () => {
    const store = new InMemoryKVStore()
    await store.put('agent-row:a1', { name: 'Sales' })
    await store.put('agent-row:b2', { name: 'Research' })

    expect(await store.get(['agent-row:a1', 'agent-row:zz'])).toEqual(
      new Map([['agent-row:a1', { name: 'Sales' }], ['agent-row:zz', null]]),
    )

    await store.delete(['agent-row:a1', 'agent-row:b2'])
    expect(await store.get(['agent-row:a1', 'agent-row:b2'])).toEqual(
      new Map([['agent-row:a1', null], ['agent-row:b2', null]]),
    )
  })

  it('refuses a value JSON cannot hold', async () => {
    const store = new InMemoryKVStore()
    await expect(store.put('agent-row:a1', undefined)).rejects.toThrow(TypeError)
  })
})
