import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appState } from './app-state'
import { defineNamespace } from './definitions'
import { reduceRecord } from './reduce-record'

const records = defineNamespace({
  name: 'test:reduce-record',
  consistency: 'strong',
  schema: z.object({ count: z.number().int(), writers: z.array(z.string()) }),
  expiry: { ttlMs: 60_000, onUpdate: 'keep' },
})

describe('reduceRecord', () => {
  it('loses no change when writers compete: each conflict is decided again from what landed', async () => {
    const key = records.key('competing')
    const writers = Array.from({ length: 12 }, (_, index) => `writer-${index}`)
    const results = await Promise.all(writers.map(writer => reduceRecord(key, (current) => {
      const next = { count: (current?.count ?? 0) + 1, writers: [...current?.writers ?? [], writer] }
      return { result: next.count, value: next }
    })))
    const stored = await appState().get(key)
    expect(stored?.value.count).toBe(12)
    expect([...stored!.value.writers].sort()).toEqual([...writers].sort())
    // Each writer's change landed at its own position.
    expect([...results].sort((a, b) => a - b)).toEqual(writers.map((_, index) => index + 1))
  })

  it('writes nothing when the decision has no value', async () => {
    const key = records.key('untouched')
    const written = await appState().set(key, { count: 1, writers: [] })
    expect(await reduceRecord(key, current => ({ result: current?.count }))).toBe(1)
    expect((await appState().get(key))?.revision).toBe(written.revision)
  })

  it('deletes only the write it decided from, and decides again after an intruding write', async () => {
    const key = records.key('delete')
    await appState().set(key, { count: 1, writers: [] })
    const intrusions: Promise<unknown>[] = []
    const seen: number[] = []
    await reduceRecord(key, (current) => {
      seen.push(current?.count ?? 0)
      // Another writer lands after the first decision, before it is written.
      if (seen.length === 1) intrusions.push(appState().set(key, { count: 5, writers: ['other'] }))
      // Deletes a record of one; keeps a bigger one.
      return current?.count === 1 ? { result: undefined, value: null } : { result: undefined }
    })
    await Promise.all(intrusions)
    expect(seen).toEqual([1, 5])
    expect((await appState().get(key))?.value).toEqual({ count: 5, writers: ['other'] })
  })

  it('applies a per-write expiry', async () => {
    const key = records.key('expiry')
    const at = Date.now() + 5_000
    await reduceRecord(key, () => ({ result: undefined, value: { count: 1, writers: [] }, expiry: { at } }))
    expect((await appState().get(key))?.expiresAt).toBe(at)
  })

  it('gives up after maxAttempts decisions that each lost to another write', async () => {
    const key = records.key('busy')
    const intrusions: Promise<unknown>[] = []
    let attempts = 0
    await expect(reduceRecord(key, () => {
      attempts++
      intrusions.push(appState().set(key, { count: attempts * 100, writers: [] }))
      return { result: undefined, value: { count: 1, writers: [] } }
    }, { maxAttempts: 3 })).rejects.toThrow(/changed under 3 updates/)
    await Promise.all(intrusions)
    expect(attempts).toBe(3)
  })
})
