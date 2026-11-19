import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { appState, closeAppState, initializeAppState } from './app-state'
import type { AppStateScope } from './contract'
import { defineNamespace, digestKeyPart } from './definitions'
import { defineFixedWindow } from './fixed-window'
import { createLocalAppState, LocalAppStateBackend } from './local-app-state'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const WINDOW_MS = 60_000

let now = T0
let backend: LocalAppStateBackend

async function install(scope?: AppStateScope): Promise<void> {
  await closeAppState()
  await initializeAppState(createLocalAppState({ scope, backend }))
}

beforeEach(async () => {
  now = T0
  backend = new LocalAppStateBackend({ now: () => now })
  await install()
})

const attempts = defineFixedWindow({ name: 'test:rate:attempts', limit: 3, windowMs: WINDOW_MS })
const client = attempts.key(digestKeyPart('203.0.113.7'))

async function hits(count: number) {
  const results = []
  for (let i = 0; i < count; i++) results.push(await attempts.hit(client))
  return results
}

describe('defineFixedWindow', () => {
  it('admits `limit` hits in a window and refuses the next without counting it', async () => {
    const [first, second, third, fourth] = await hits(4)

    expect(first).toEqual({ admitted: true, count: 1, remaining: 2, resetAt: T0 + WINDOW_MS })
    expect(second).toMatchObject({ admitted: true, count: 2, remaining: 1 })
    expect(third).toMatchObject({ admitted: true, count: 3, remaining: 0 })
    expect(fourth).toEqual({ admitted: false, count: 3, remaining: 0, resetAt: T0 + WINDOW_MS })
    expect((await appState().get(client))?.value).toBe(3)
  })

  it('opens the window at the first hit and closes it exactly `windowMs` later', async () => {
    now = T0 + 5_000
    await hits(3)

    now = T0 + 5_000 + WINDOW_MS - 1
    expect(await attempts.hit(client)).toMatchObject({ admitted: false, resetAt: T0 + 5_000 + WINDOW_MS })

    // At the end instant the window is over: the hit opens the next one.
    now = T0 + 5_000 + WINDOW_MS
    expect(await attempts.hit(client)).toEqual({
      admitted: true,
      count: 1,
      remaining: 2,
      resetAt: T0 + 5_000 + 2 * WINDOW_MS,
    })
  })

  it('keeps the original end: a burst near the end of a window does not extend it', async () => {
    await attempts.hit(client)
    now = T0 + WINDOW_MS - 10
    // The rest of the window's hits, and refused ones after them, all late in the window.
    const late = await hits(4)
    expect(late.map((hit) => hit.admitted)).toEqual([true, true, false, false])
    expect(late.every((hit) => hit.resetAt === T0 + WINDOW_MS)).toBe(true)

    // A sliding window would still be full here; the fixed one has started over.
    now = T0 + WINDOW_MS
    expect(await attempts.hit(client)).toMatchObject({ admitted: true, count: 1 })
  })

  it('counts every competing hit and admits exactly `limit` of them', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => attempts.hit(client)))

    expect(results.filter((hit) => hit.admitted)).toHaveLength(3)
    expect(results.filter((hit) => hit.admitted).map((hit) => hit.count).sort()).toEqual([1, 2, 3])
    expect((await appState().get(client))?.value).toBe(3)
  })

  it('counts each key on its own', async () => {
    await hits(3)
    const other = attempts.key(digestKeyPart('198.51.100.2'))
    expect(await attempts.hit(other)).toMatchObject({ admitted: true, count: 1 })
    expect(await attempts.hit(client)).toMatchObject({ admitted: false })
  })

  it('counts each tenant on its own', async () => {
    await install({ deploymentId: 'cloud', tenantId: 'org-a' })
    await hits(3)
    expect(await attempts.hit(client)).toMatchObject({ admitted: false })

    await install({ deploymentId: 'cloud', tenantId: 'org-b' })
    expect(await attempts.hit(client)).toMatchObject({ admitted: true, count: 1 })

    await install({ deploymentId: 'cloud', tenantId: 'org-a' })
    expect(await attempts.hit(client)).toMatchObject({ admitted: false, count: 3 })
  })

  it('refuses a key of another namespace and a limit below one', async () => {
    const other = defineNamespace({
      name: 'test:rate:other',
      consistency: 'strong',
      schema: z.number(),
      expiry: { ttlMs: null, onUpdate: 'keep' },
    })
    await expect(attempts.hit(other.key('x'))).rejects.toThrow('the key belongs to test:rate:other')
    expect(() => defineFixedWindow({ name: 'test:rate:none', limit: 0, windowMs: 1_000 })).toThrow(RangeError)
  })
})
