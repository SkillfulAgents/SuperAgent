/**
 * The behavior every AppState implementation shares. An implementation's test
 * runs it with a backend whose clock the test moves:
 *
 *   describeAppStateConformance('LocalAppState', () => ({ open, advance, settled }))
 *
 * Each test opens two clients of one tenant (two processes) and one of
 * another tenant over a fresh backend.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AppState, AppStateScope, Channel, Revision } from '../contract'
import { defineNamespace, defineTopic } from '../definitions'

export interface ConformanceBackend {
  /** A client for the scope. Two clients of one scope share its state, as two processes do. */
  open(scope: AppStateScope): AppState | Promise<AppState>
  /** Moves the backend's clock forward. */
  advance(ms: number): void | Promise<void>
  /** Resolves once every event published so far was delivered or dropped and its listeners returned. */
  settled(): Promise<void>
  dispose?(): void | Promise<void>
}

const TENANT_A: AppStateScope = { deploymentId: 'conformance', tenantId: 'org-a' }
const TENANT_B: AppStateScope = { deploymentId: 'conformance', tenantId: 'org-b' }
const TTL = 1_000

const record = z.object({ n: z.number(), tags: z.array(z.string()) })
type Record = z.infer<typeof record>

const fixed = defineNamespace({ name: 'conformance:fixed', consistency: 'strong', schema: record, expiry: { ttlMs: TTL, onUpdate: 'keep' } })
const sliding = defineNamespace({ name: 'conformance:sliding', consistency: 'strong', schema: z.string(), expiry: { ttlMs: TTL, onUpdate: 'reset' } })
const lasting = defineNamespace({ name: 'conformance:lasting', consistency: 'strong', schema: z.string(), expiry: { ttlMs: null, onUpdate: 'keep' } })
const counter = defineNamespace({ name: 'conformance:counter', consistency: 'strong', schema: z.number().int(), expiry: { ttlMs: TTL, onUpdate: 'keep' } })
const stock = defineNamespace({ name: 'conformance:stock', consistency: 'strong', schema: z.number().int().min(0), expiry: { ttlMs: TTL, onUpdate: 'keep' } })
const pairs = defineNamespace({ name: 'conformance:pairs', consistency: 'strong', schema: z.number().int().multipleOf(2), expiry: { ttlMs: TTL, onUpdate: 'keep' } })
const cache = defineNamespace({ name: 'conformance:cache', consistency: 'eventual', schema: record, expiry: { ttlMs: TTL, onUpdate: 'reset' } })
const pings = defineTopic({ name: 'events:conformance:ping', schema: z.object({ seq: z.number(), tags: z.array(z.string()) }) })
// One name extends the other, and their key parts spell the same text: still different keys.
const pending = defineNamespace({ name: 'conformance:pending', consistency: 'strong', schema: z.string(), expiry: { ttlMs: null, onUpdate: 'keep' } })
const pendingOauth = defineNamespace({ name: 'conformance:pending:oauth', consistency: 'eventual', schema: z.string(), expiry: { ttlMs: TTL, onUpdate: 'reset' } })
const agentPings = defineTopic({ name: 'events:conformance:ping:agent', schema: pings.schema })

const value = (n: number): Record => ({ n, tags: ['a'] })

export function describeAppStateConformance(name: string, createBackend: () => ConformanceBackend | Promise<ConformanceBackend>): void {
  describe(`${name} meets the AppState contract`, () => {
    let backend: ConformanceBackend
    let clients: AppState[]
    /** A client of tenant A. */
    let a: AppState
    /** Another client of tenant A: a second process. */
    let a2: AppState
    /** A client of tenant B. */
    let b: AppState

    beforeEach(async () => {
      backend = await createBackend()
      clients = [await backend.open(TENANT_A), await backend.open(TENANT_A), await backend.open(TENANT_B)]
      ;[a, a2, b] = clients
    })

    afterEach(async () => {
      for (const client of clients) await client.close().catch(() => {})
      await backend.dispose?.()
    })

    describe('state', () => {
      it('treats a key never written as absent', async () => {
        const key = fixed.key('never-written')
        expect(await a.get(key)).toBeNull()
        await expect(a.delete(key)).resolves.toBeUndefined()
        expect(await a.consume(key)).toEqual({ consumed: false, current: null })
      })

      it('returns what was set to every client of the tenant, as copies neither side can change', async () => {
        const written = value(1)
        const key = fixed.key('copy')
        const entry = await a.set(key, written)
        written.tags.push('changed-after-set')
        entry.value.tags.push('changed-in-result')

        const read = await a2.get(key)
        expect(read).toEqual({ value: value(1), revision: entry.revision, expiresAt: entry.expiresAt })
        read!.value.tags.push('changed-after-get')
        expect((await a.get(key))?.value).toEqual(value(1))

        const insert = await a.insertIfAbsent(key, value(2))
        if (insert.inserted) throw new Error('expected the key to be taken')
        insert.current.value.tags.push('changed-in-current')
        expect((await a.get(key))?.value).toEqual(value(1))
      })

      it('rejects a value its namespace schema rejects and stores nothing', async () => {
        const key = fixed.key('invalid')
        await expect(a.set(key, { n: 'one' } as never)).rejects.toThrow()
        await expect(a.insertIfAbsent(key, { n: 1 } as never)).rejects.toThrow()
        await expect(a.compareAndSet(key, null, null as never)).rejects.toThrow()
        expect(await a.get(key)).toBeNull()
      })

      it('reads several keys at once, in order, with null for an absent one', async () => {
        await a.set(fixed.key('first'), value(1))
        await a.set(fixed.key('third'), value(3))

        const read = await a2.getMany([fixed.key('first'), fixed.key('second'), fixed.key('third')])
        expect(read.map((entry) => entry?.value ?? null)).toEqual([value(1), null, value(3)])
      })

      it('gives every write a new revision, also when the value is the same', async () => {
        const key = lasting.key('same')
        const revisions = new Set<Revision>()
        for (let i = 0; i < 5; i++) revisions.add((await a.set(key, 'unchanged')).revision)
        expect(revisions.size).toBe(5)
      })

      it('stops returning an entry at its expiry and treats it as absent from then on', async () => {
        const key = fixed.key('expiring')
        const written = await a.set(key, value(1))
        await backend.advance(TTL - 1)
        expect((await a2.get(key))?.value).toEqual(value(1))

        await backend.advance(1)
        expect(await a2.get(key)).toBeNull()
        expect(await a.compareAndSet(key, written.revision, value(2))).toEqual({ ok: false, current: null })
        expect(await a.consume(key)).toEqual({ consumed: false, current: null })
        expect((await a.insertIfAbsent(key, value(3))).inserted).toBe(true)

        const count = counter.key('expiring')
        await a.increment(count, 5)
        await backend.advance(TTL)
        expect(await a.increment(count)).toMatchObject({ applied: true, entry: { value: 1 } })
      })

      it('keeps the original expiry on update in a keep namespace and resets it in a reset namespace', async () => {
        const kept = fixed.key('kept')
        const reset = sliding.key('reset')
        const first = await a.set(kept, value(1))
        await a.set(reset, 'first')

        await backend.advance(600)
        const updated = await a.compareAndSet(kept, first.revision, value(2))
        expect(updated).toMatchObject({ ok: true, entry: { expiresAt: first.expiresAt } })
        await a.set(reset, 'second')

        await backend.advance(600)
        expect(await a.get(kept)).toBeNull()
        expect((await a.get(reset))?.value).toBe('second')
        await backend.advance(TTL - 600)
        expect(await a.get(reset)).toBeNull()
      })

      it('lets one write choose its own expiry', async () => {
        const key = fixed.key('chosen')
        const short = await a.set(key, value(1), { expiry: { ttlMs: 100 } })
        const absolute = await a.set(fixed.key('absolute'), value(1), { expiry: { at: short.expiresAt! + 50 } })
        expect(absolute.expiresAt).toBe(short.expiresAt! + 50)
        const forever = await a.set(fixed.key('forever'), value(1), { expiry: 'never' })
        expect(forever.expiresAt).toBeNull()

        await backend.advance(100)
        expect(await a.get(key)).toBeNull()
        expect(await a.get(fixed.key('absolute'))).not.toBeNull()
        await backend.advance(TTL * 10)
        expect(await a.get(fixed.key('absolute'))).toBeNull()
        expect((await a.get(fixed.key('forever')))?.value).toEqual(value(1))

        const keep = sliding.key('keep')
        const created = await a.set(keep, 'first')
        await backend.advance(500)
        expect((await a.set(keep, 'second', { expiry: 'keep' })).expiresAt).toBe(created.expiresAt)
        expect((await a.set(keep, 'third', { expiry: 'reset' })).expiresAt).toBeGreaterThan(created.expiresAt!)
      })

      it('never matches a revision from before the key was deleted or expired and written again', async () => {
        const key = fixed.key('recreated')
        const before = await a.set(key, value(1))
        await a.delete(key)
        const after = await a.set(key, value(1))
        expect(after.revision).not.toBe(before.revision)
        expect(await a2.compareAndSet(key, before.revision, value(2))).toMatchObject({ ok: false, current: { revision: after.revision } })
        expect(await a2.consume(key, { revision: before.revision })).toMatchObject({ consumed: false })

        await backend.advance(TTL)
        const again = await a.insertIfAbsent(key, value(1))
        if (!again.inserted) throw new Error('expected the expired key to be absent')
        expect([before.revision, after.revision]).not.toContain(again.entry.revision)
        expect((await a2.compareAndSet(key, after.revision, value(2))).ok).toBe(false)
        expect((await a2.get(key))?.value).toEqual(value(1))
      })

      it('lets exactly one of competing inserts win, and shows the others the winner', async () => {
        const key = fixed.key('claim')
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => (i % 2 ? a : a2).insertIfAbsent(key, value(i))),
        )
        const winners = results.filter((result) => result.inserted)
        expect(winners).toHaveLength(1)
        const winner = winners[0].inserted ? winners[0].entry : null
        for (const result of results) {
          if (!result.inserted) expect(result.current).toEqual(winner)
        }
        expect(await a.get(key)).toEqual(winner)
      })

      it('lets exactly one of competing compare-and-sets from the same revision win', async () => {
        const key = fixed.key('contended')
        const base = await a.set(key, value(0))
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => (i % 2 ? a : a2).compareAndSet(key, base.revision, value(i + 1))),
        )
        const winners = results.flatMap((result) => (result.ok ? [result.entry] : []))
        expect(winners).toHaveLength(1)
        for (const result of results) {
          if (!result.ok) expect(result.current).toEqual(winners[0])
        }
        expect(await a.get(key)).toEqual(winners[0])
      })

      it('creates with compareAndSet(null) only while the key is absent', async () => {
        const key = lasting.key('create')
        const created = await a.compareAndSet(key, null, 'first')
        expect(created.ok).toBe(true)
        expect(await a2.compareAndSet(key, null, 'second')).toMatchObject({ ok: false, current: { value: 'first' } })
      })

      it('loses no increments or decrements made concurrently by two clients', async () => {
        const key = counter.key('hits')
        await Promise.all([
          ...Array.from({ length: 30 }, (_, i) => (i % 2 ? a : a2).increment(key)),
          ...Array.from({ length: 10 }, (_, i) => (i % 2 ? a : a2).decrement(key)),
          a.increment(key, 7),
          a2.decrement(key, 2),
        ])
        expect((await a.get(key))?.value).toBe(25)
      })

      it('refuses a change that would leave the bounds and keeps the counter as it was', async () => {
        const key = counter.key('bounded')
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : a2).increment(key, 1, { max: 4 })))
        expect(results.filter((result) => result.applied)).toHaveLength(4)
        const refused = results.find((result) => !result.applied)
        expect(refused).toMatchObject({ applied: false, current: { value: 4 } })

        expect(await a.decrement(counter.key('floor'), 1, { min: 0 })).toEqual({ applied: false, current: null })
        expect(await a.get(counter.key('floor'))).toBeNull()
        await expect(a.increment(key, 0.5)).rejects.toThrow(RangeError)
      })

      it('refuses a change its counter schema rejects and stores nothing', async () => {
        const key = stock.key('left')
        await expect(a.decrement(key)).rejects.toThrow()
        expect(await a.get(key)).toBeNull()

        await a.increment(key, 2)
        await expect(a2.decrement(key, 3)).rejects.toThrow()
        expect((await a.get(key))?.value).toBe(2)
      })

      it('refuses to count under a schema with a rule past its bounds, and stores nothing', async () => {
        const key = pairs.key('even')
        await expect(a.increment(key, 1)).rejects.toThrow(TypeError)
        expect(await a.get(key)).toBeNull()
      })

      it('lets exactly one of competing consumes take the entry', async () => {
        const key = fixed.key('once')
        const written = await a.set(key, value(1))
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : a2).consume(key)))
        const taken = results.filter((result) => result.consumed)
        expect(taken).toEqual([{ consumed: true, entry: written }])
        expect(await a.get(key)).toBeNull()
      })

      it('consumes on a revision only while the key holds that write', async () => {
        const key = fixed.key('conditional')
        const first = await a.set(key, value(1))
        const second = await a2.set(key, value(2))

        expect(await a.consume(key, { revision: first.revision })).toEqual({ consumed: false, current: second })
        expect(await a.get(key)).toEqual(second)
        expect(await a.consume(key, { revision: second.revision })).toEqual({ consumed: true, entry: second })
        expect(await a.get(key)).toBeNull()
      })

      it('offers only plain reads and writes on an eventual namespace, which must expire', async () => {
        const key = cache.key('listing')
        const entry = await a.set(key, value(1))
        expect(entry.expiresAt).not.toBeNull()
        await expect(a.set(key, value(1), { expiry: 'never' })).rejects.toThrow()
        // The types refuse these; a backend must too.
        const loose = key as never
        await expect(a.insertIfAbsent(loose, value(1))).rejects.toThrow()
        await expect(a.compareAndSet(loose, entry.revision, value(2))).rejects.toThrow()
        await expect(a.increment(loose)).rejects.toThrow()
        await expect(a.consume(loose)).rejects.toThrow()
        await a.delete(key)
        expect(await a.get(key)).toBeNull()
      })

      it('keeps tenants apart', async () => {
        const key = fixed.key('shared-name')
        await a.set(key, value(1))
        expect(await b.get(key)).toBeNull()
        expect((await b.insertIfAbsent(key, value(2))).inserted).toBe(true)
        await b.delete(key)
        expect((await a.get(key))?.value).toEqual(value(1))

        await a.increment(counter.key('hits'), 3)
        expect(await b.increment(counter.key('hits'))).toMatchObject({ applied: true, entry: { value: 1 } })
      })

      it('encodes key parts, so splitting the same text differently names different keys', async () => {
        await a.set(lasting.key('a:b', 'c'), 'first split')
        await a.set(lasting.key('a', 'b:c'), 'second split')
        await a.set(lasting.key('a:b:c'), 'one part')
        expect((await a.get(lasting.key('a:b', 'c')))?.value).toBe('first split')
        expect((await a.get(lasting.key('a', 'b:c')))?.value).toBe('second split')
        expect((await a.get(lasting.key('a:b:c')))?.value).toBe('one part')
      })

      it('keeps namespaces apart when one name extends the other', async () => {
        const strongKey = pending.key('oauth', 'flow')
        const cacheKey = pendingOauth.key('flow')
        expect(strongKey.path).not.toBe(cacheKey.path)

        await a.set(strongKey, 'pending flow')
        expect(await a2.get(cacheKey)).toBeNull()
        await a.set(cacheKey, 'cached copy')
        await a2.delete(cacheKey)
        expect((await a.get(strongKey))?.value).toBe('pending flow')
        expect(await a.get(cacheKey)).toBeNull()
      })
    })

    describe('pubsub', () => {
      const listen = async (client: AppState, channels: Channel<{ seq: number; tags: string[] }>[]) => {
        const seen: { seq: number; path: string }[] = []
        const subscription = await client.subscribe(channels, (event, channel) => {
          seen.push({ seq: event.seq, path: channel.path })
        })
        return { seen, subscription }
      }

      it('delivers an event to every subscriber of its channel in the tenant, each with its own copy', async () => {
        const channel = pings.channel('agent-1')
        const copies: string[] = []
        const mutate = (event: { seq: number; tags: string[] }) => {
          copies.push(JSON.stringify(event))
          event.tags.push('changed-by-listener')
        }
        await a.subscribe([channel], mutate)
        await a2.subscribe([channel], mutate)

        const event = { seq: 1, tags: ['a'] }
        await a.publish(channel, event)
        event.tags.push('changed-by-publisher')
        await backend.settled()
        expect(copies).toEqual([JSON.stringify({ seq: 1, tags: ['a'] }), JSON.stringify({ seq: 1, tags: ['a'] })])
      })

      it('delivers the events of several channels to one listener, with the channel each came on', async () => {
        const first = pings.channel('agent-1')
        const second = pings.channel('agent-2')
        const { seen } = await listen(a2, [first, second])
        await a.publish(first, { seq: 1, tags: [] })
        await a.publish(second, { seq: 2, tags: [] })
        await a.publish(pings.channel('agent-3'), { seq: 3, tags: [] })
        await backend.settled()
        expect(seen).toEqual(expect.arrayContaining([{ seq: 1, path: first.path }, { seq: 2, path: second.path }]))
        expect(seen).toHaveLength(2)
      })

      it('resolves publish without waiting for listeners to finish', async () => {
        const channel = pings.channel('slow')
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        let finished = false
        await a2.subscribe([channel], async () => {
          await gate
          finished = true
        })

        await a.publish(channel, { seq: 1, tags: [] })
        expect(finished).toBe(false)
        release()
        await backend.settled()
        expect(finished).toBe(true)
      })

      it('rejects an event its topic schema rejects and delivers nothing', async () => {
        const channel = pings.channel('invalid')
        const { seen } = await listen(a2, [channel])
        await expect(a.publish(channel, { seq: 'one' } as never)).rejects.toThrow()
        await backend.settled()
        expect(seen).toEqual([])
      })

      it('calls a listener no more once unsubscribe resolved', async () => {
        const channel = pings.channel('leaving')
        const { seen, subscription } = await listen(a2, [channel])
        await a.publish(channel, { seq: 1, tags: [] })
        await backend.settled()
        expect(seen.map((event) => event.seq)).toEqual([1])

        await a.publish(channel, { seq: 2, tags: [] })
        await subscription.unsubscribe()
        const atUnsubscribe = seen.length
        await subscription.unsubscribe()
        await a.publish(channel, { seq: 3, tags: [] })
        await backend.settled()
        expect(seen).toHaveLength(atUnsubscribe)
      })

      it('ends a subscription when its signal aborts, also one aborted before it was set up', async () => {
        const channel = pings.channel('aborted')
        const early = new AbortController()
        early.abort()
        const earlySeen: number[] = []
        await a2.subscribe([channel], (event) => {
          earlySeen.push(event.seq)
        }, { signal: early.signal })

        const late = new AbortController()
        const lateSeen: number[] = []
        await a2.subscribe([channel], (event) => {
          lateSeen.push(event.seq)
        }, { signal: late.signal })
        await a.publish(channel, { seq: 1, tags: [] })
        await backend.settled()
        late.abort()
        await a.publish(channel, { seq: 2, tags: [] })
        await backend.settled()

        expect(earlySeen).toEqual([])
        expect(lateSeen).toEqual([1])
      })

      it('ends the subscriptions of a closed client', async () => {
        const channel = pings.channel('closing')
        const { seen } = await listen(a2, [channel])
        await a2.close()
        await a.publish(channel, { seq: 1, tags: [] })
        await backend.settled()
        expect(seen).toEqual([])
      })

      it('keeps topics apart when one name extends the other', async () => {
        const outer = pings.channel('agent', 'x')
        const nested = agentPings.channel('x')
        expect(outer.path).not.toBe(nested.path)
        const onOuter = await listen(a2, [outer])
        const onNested = await listen(a2, [nested])

        await a.publish(outer, { seq: 1, tags: [] })
        await a.publish(nested, { seq: 2, tags: [] })
        await backend.settled()
        expect(onOuter.seen.map((event) => event.seq)).toEqual([1])
        expect(onNested.seen.map((event) => event.seq)).toEqual([2])
      })

      it('keeps tenants apart', async () => {
        const channel = pings.channel('agent-1')
        const inA = await listen(a2, [channel])
        const inB = await listen(b, [channel])
        await a.publish(channel, { seq: 1, tags: [] })
        await b.publish(channel, { seq: 2, tags: [] })
        await backend.settled()
        expect(inA.seen.map((event) => event.seq)).toEqual([1])
        expect(inB.seen.map((event) => event.seq)).toEqual([2])
      })
    })
  })
}
