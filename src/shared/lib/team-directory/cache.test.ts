import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('@shared/lib/db', () => ({ get db() { return state.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'team-directory-test-secret' }))

import { cachedDirectoryUsers, forgetDirectoryUsers, LISTING_FRESH_MS, LISTING_RETRY_MS } from './cache'
import { registerDirectoryProvider } from './registry'
import { getDirectoryConnection, saveDirectoryConnection, type DirectoryConnection } from './store'
import { createFakeDirectoryProvider, type FakeDirectory } from './testing/fake-directory-provider'

let handle: TestDatabase
let fake: FakeDirectory
let unregister: () => void

async function connect(tenantId = 'acme'): Promise<DirectoryConnection> {
  return saveDirectoryConnection({
    provider: fake.provider.info.id,
    tenant: { tenantId, tenantName: tenantId.toUpperCase() },
    credentials: { token: `${tenantId}-token` },
    createdByUserId: null,
  })
}

beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  fake = createFakeDirectoryProvider()
  unregister = registerDirectoryProvider(fake.provider)
  fake.setPeople('acme', [fake.person('acme', 'u1', 'Dana Whitfield', 'dana@acme.test')])
})

afterEach(async () => {
  vi.useRealTimers()
  await backgroundSettled()
  unregister()
  await handle.close()
})

describe('cachedDirectoryUsers', () => {
  it('lists a directory with nothing cached, then answers from the cache while it is fresh', async () => {
    const directory = await connect()
    expect((await cachedDirectoryUsers(directory, { waitMs: 1_000 })).map((u) => u.name)).toEqual(['Dana Whitfield'])
    fake.setPeople('acme', [])
    expect((await cachedDirectoryUsers(directory, { waitMs: 1_000 })).map((u) => u.name)).toEqual(['Dana Whitfield'])
    expect(fake.listCalls).toEqual(['acme'])
  })

  it('makes one listing for concurrent searches', async () => {
    const directory = await connect()
    const release = fake.holdListings()
    const searches = Promise.all([1, 2, 3].map(() => cachedDirectoryUsers(directory, { waitMs: 1_000 })))
    await vi.waitFor(() => expect(fake.listCalls).toHaveLength(1))
    release()
    expect((await searches).map((users) => users.length)).toEqual([1, 1, 1])
    expect(fake.listCalls).toHaveLength(1)
  })

  it('answers a stale listing at once and refreshes it in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const directory = await connect()
    await cachedDirectoryUsers(directory, { waitMs: 1_000 })
    fake.setPeople('acme', [fake.person('acme', 'u2', 'Sara Kim', 'sara@acme.test')])

    vi.setSystemTime(Date.now() + LISTING_FRESH_MS + 1)
    expect((await cachedDirectoryUsers(directory, { waitMs: 1_000 })).map((u) => u.name)).toEqual(['Dana Whitfield'])
    await backgroundSettled()
    expect((await cachedDirectoryUsers(directory, { waitMs: 1_000 })).map((u) => u.name)).toEqual(['Sara Kim'])
    expect(fake.listCalls).toHaveLength(2)
  })

  it('answers without a slow first listing, which then lands in the cache', async () => {
    const directory = await connect()
    const release = fake.holdListings()
    expect(await cachedDirectoryUsers(directory, { waitMs: 20 })).toEqual([])
    release()
    await backgroundSettled()
    expect((await cachedDirectoryUsers(directory, { waitMs: 0 })).map((u) => u.name)).toEqual(['Dana Whitfield'])
    expect(fake.listCalls).toHaveLength(1)
  })

  it('starts the listing without waiting when asked not to wait (the picker opening)', async () => {
    const directory = await connect()
    expect(await cachedDirectoryUsers(directory, { waitMs: 0 })).toEqual([])
    await backgroundSettled()
    expect(await cachedDirectoryUsers(directory, { waitMs: 0 })).toHaveLength(1)
  })

  it('keeps the last good listing through a failure, marks the directory, and waits before trying again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const directory = await connect()
    await cachedDirectoryUsers(directory, { waitMs: 1_000 })

    fake.failListings('acme')
    vi.setSystemTime(Date.now() + LISTING_FRESH_MS + 1)
    expect(await cachedDirectoryUsers(directory, { waitMs: 1_000 })).toHaveLength(1)
    await backgroundSettled()
    expect(await getDirectoryConnection(directory.id)).toMatchObject({ status: 'error', errorMessage: 'The fake directory is down' })

    // Within the retry interval nothing is asked.
    expect(await cachedDirectoryUsers(directory, { waitMs: 1_000 })).toHaveLength(1)
    expect(fake.listCalls).toHaveLength(2)

    fake.failListings('acme', null)
    vi.setSystemTime(Date.now() + LISTING_RETRY_MS + 1)
    await cachedDirectoryUsers(directory, { waitMs: 1_000 })
    await backgroundSettled()
    expect(fake.listCalls).toHaveLength(3)
    expect(await getDirectoryConnection(directory.id)).toMatchObject({ status: 'active', errorMessage: null })
  })

  it('starts afresh when the directory is connected again with new credentials', async () => {
    const first = await connect()
    await cachedDirectoryUsers(first, { waitMs: 1_000 })
    const reconnected = await connect()
    expect(reconnected.id).toBe(first.id)
    expect(reconnected.revision).toBe(first.revision + 1)
    fake.setPeople('acme', [])
    expect(await cachedDirectoryUsers(reconnected, { waitMs: 1_000 })).toEqual([])
    expect(fake.listCalls).toHaveLength(2)
  })

  it('forgets a disconnected directory', async () => {
    const directory = await connect()
    await cachedDirectoryUsers(directory, { waitMs: 1_000 })
    await forgetDirectoryUsers(directory)
    await cachedDirectoryUsers(directory, { waitMs: 1_000 })
    expect(fake.listCalls).toHaveLength(2)
  })
})
