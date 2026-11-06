import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { backgroundSettled } from '@shared/lib/background'
import { defineNamespace, defineTopic } from './definitions'
import { createLocalAppState, LocalAppStateBackend, MemoryEntryStore } from './local-app-state'
import { describeAppStateConformance } from './testing/conformance'

describeAppStateConformance('LocalAppState', () => {
  let now = Date.parse('2026-11-04T12:00:00Z')
  const backend = new LocalAppStateBackend({ now: () => now })
  return {
    open: (scope) => createLocalAppState({ scope, backend }),
    advance: (ms) => {
      now += ms
    },
    settled: backgroundSettled,
  }
})

const claims = defineNamespace({
  name: 'test:claims',
  consistency: 'strong',
  schema: z.string(),
  expiry: { ttlMs: 1_000, onUpdate: 'keep' },
})
const lasting = defineNamespace({
  name: 'test:lasting',
  consistency: 'strong',
  schema: z.string(),
  expiry: { ttlMs: null, onUpdate: 'keep' },
})
const pings = defineTopic({ name: 'events:test:ping', schema: z.object({ seq: z.number() }) })

describe('LocalAppState', () => {
  it('never issues a revision a previous process issued', async () => {
    const before = await createLocalAppState({ backend: new LocalAppStateBackend() }).set(claims.key('k'), 'v')
    const after = await createLocalAppState({ backend: new LocalAppStateBackend() }).set(claims.key('k'), 'v')
    expect(after.revision).not.toBe(before.revision)
  })

  it('reports a failing listener and still delivers to the others', async () => {
    const onListenerError = vi.fn()
    const state = createLocalAppState({ backend: new LocalAppStateBackend({ onListenerError }) })
    const channel = pings.channel('agent-1')
    const seen: number[] = []
    await state.subscribe([channel], () => {
      throw new Error('listener broke')
    })
    await state.subscribe([channel], async () => {
      throw new Error('async listener broke')
    })
    await state.subscribe([channel], (event) => {
      seen.push(event.seq)
    })

    await state.publish(channel, { seq: 1 })
    await backgroundSettled()

    expect(seen).toEqual([1])
    expect(onListenerError).toHaveBeenCalledTimes(2)
    expect(onListenerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener broke' }), channel)
  })

  it('drops an event already on its way to a subscription that ends before it arrives', async () => {
    const state = createLocalAppState({ backend: new LocalAppStateBackend() })
    const channel = pings.channel('agent-1')
    const leaving = new AbortController()
    const seen: number[] = []
    await state.subscribe([channel], () => leaving.abort())
    await state.subscribe([channel], (event) => {
      seen.push(event.seq)
    }, { signal: leaving.signal })

    await state.publish(channel, { seq: 1 })
    await backgroundSettled()

    expect(seen).toEqual([])
  })

  it('sweeps expired entries as writes accumulate, without anyone reading them', async () => {
    let now = 0
    const backend = new LocalAppStateBackend({ now: () => now })
    const state = createLocalAppState({ backend })
    for (let i = 0; i < 500; i++) await state.set(claims.key(`old-${i}`), 'v')
    now += 1_000
    for (let i = 0; i < 1_000; i++) await state.set(claims.key(`new-${i % 10}`), 'v')
    expect(backend.entryCount).toBe(10)
  })

  it('keeps sweeping while new keys keep arriving, so expired entries stay bounded', async () => {
    let now = 0
    const backend = new LocalAppStateBackend({ now: () => now })
    const state = createLocalAppState({ backend })
    // Entries that never expire, so every sweep keeps a sizable set.
    for (let i = 0; i < 1_500; i++) await state.set(lasting.key(`kept-${i}`), 'v')
    // Then only unique keys, each expiring 1 s (1,000 writes) after it was written.
    for (let i = 0; i < 20_000; i++) {
      now += 1
      await state.set(claims.key(`unique-${i}`), 'v')
    }
    // A sweep keeps at most the 1,500 lasting entries and 1,000 live claims,
    // and the next one runs 2,500 writes later: at most 2,500 more in between.
    expect(backend.entryCount).toBeLessThanOrEqual(1_500 + 1_000 + 2_500)
  })

  it('reads what a kept store holds from a previous process, and issues new revisions over it', async () => {
    const store = new MemoryEntryStore()
    const before = await createLocalAppState({ backend: new LocalAppStateBackend({ store }) }).set(lasting.key('k'), 'v1')
    const state = createLocalAppState({ backend: new LocalAppStateBackend({ store }) })

    expect(await state.get(lasting.key('k'))).toEqual(before)
    const swapped = await state.compareAndSet(lasting.key('k'), before.revision, 'v2')
    expect(swapped.ok && swapped.entry.revision !== before.revision).toBe(true)
  })

  it('refuses use once closed', async () => {
    const state = createLocalAppState()
    await state.close()
    await expect(state.get(claims.key('k'))).rejects.toThrow('closed')
    await expect(state.publish(pings.channel('a'), { seq: 1 })).rejects.toThrow('closed')
  })
})
