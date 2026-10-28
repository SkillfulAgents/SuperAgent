import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AppDatabase } from '../../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('../../db', () => ({
  get db() {
    return testDb
  },
}))

import {
  upsertPushSubscription,
  listPushSubscriptions,
  deletePushSubscriptionById,
  deletePushSubscriptionByEndpoint,
  MAX_PUSH_SUBSCRIPTIONS_PER_OWNER,
} from './push-subscription-service'
import { getVapidKeys, getOrCreateVapidKeys } from './vapid-keys'

const BASE_SUB = {
  endpoint: 'https://push.example/sub-1',
  p256dh: 'p256dh-key',
  auth: 'auth-secret',
  origin: 'https://host.tailnet.ts.net',
  userId: null,
}

describe('push-subscription-service', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts a new subscription', async () => {
    await upsertPushSubscription({ ...BASE_SUB, deviceName: 'iPhone' })

    const rows = await listPushSubscriptions()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      endpoint: BASE_SUB.endpoint,
      keysP256dh: 'p256dh-key',
      keysAuth: 'auth-secret',
      origin: 'https://host.tailnet.ts.net',
      userId: null,
      deviceName: 'iPhone',
    })
  })

  it('upserts by endpoint — re-subscribing refreshes keys/origin instead of duplicating', async () => {
    await upsertPushSubscription(BASE_SUB)
    await upsertPushSubscription({
      ...BASE_SUB,
      p256dh: 'rotated-p256dh',
      origin: 'https://192.168.1.10:3000',
    })

    const rows = await listPushSubscriptions()
    expect(rows).toHaveLength(1)
    expect(rows[0].keysP256dh).toBe('rotated-p256dh')
    expect(rows[0].origin).toBe('https://192.168.1.10:3000')
  })

  it('deletes by id', async () => {
    await upsertPushSubscription(BASE_SUB)
    const [row] = await listPushSubscriptions()

    await deletePushSubscriptionById(row.id)

    expect(await listPushSubscriptions()).toHaveLength(0)
  })

  describe('per-owner subscription cap', () => {
    it('rejects a new endpoint once the owner is at the cap; refreshing an existing one still works', async () => {
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_OWNER; i++) {
        expect(
          await upsertPushSubscription({ ...BASE_SUB, endpoint: `https://push.example/dev-${i}` })
        ).toBe(true)
      }

      expect(
        await upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/one-too-many' })
      ).toBe(false)
      expect(await listPushSubscriptions()).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_OWNER)

      // Re-upserting an endpoint that already exists is a refresh, not growth.
      expect(
        await upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/dev-0', p256dh: 'new' })
      ).toBe(true)
    })

    it('the cap is per owner, not global', async () => {
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_OWNER; i++) {
        await upsertPushSubscription({ ...BASE_SUB, endpoint: `https://push.example/a-${i}`, userId: 'user-a' })
      }
      expect(
        await upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/b-0', userId: 'user-b' })
      ).toBe(true)
    })

    it('two concurrent subscribes with one slot left admit exactly one', async () => {
      // The cap is checked by the insert statement itself, not by a read
      // before it, so racing callers cannot both see the free slot.
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_OWNER - 1; i++) {
        await upsertPushSubscription({ ...BASE_SUB, endpoint: `https://push.example/dev-${i}` })
      }

      const admitted = await Promise.all([
        upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/racer-a' }),
        upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/racer-b' }),
      ])

      expect(admitted.filter(Boolean)).toHaveLength(1)
      expect(await listPushSubscriptions()).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_OWNER)
    })
  })

  describe('deletePushSubscriptionByEndpoint owner scoping', () => {
    it('an auth-mode user cannot delete another user’s subscription by endpoint', async () => {
      await upsertPushSubscription({ ...BASE_SUB, userId: 'user-a' })

      expect(await deletePushSubscriptionByEndpoint(BASE_SUB.endpoint, 'user-b')).toBe(false)
      expect(await listPushSubscriptions()).toHaveLength(1)

      expect(await deletePushSubscriptionByEndpoint(BASE_SUB.endpoint, 'user-a')).toBe(true)
      expect(await listPushSubscriptions()).toHaveLength(0)
    })

    it('local mode (no owner) deletes by endpoint alone — including rows from a previous auth-mode life', async () => {
      await upsertPushSubscription({ ...BASE_SUB, userId: 'user-a' })

      expect(await deletePushSubscriptionByEndpoint(BASE_SUB.endpoint)).toBe(true)
      expect(await listPushSubscriptions()).toHaveLength(0)
    })

    it('returns false when nothing matches (route surfaces this as 404)', async () => {
      expect(await deletePushSubscriptionByEndpoint('https://push.example/nope')).toBe(false)
    })
  })
})

describe('vapid-keys', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await handle.close()
  })

  it('returns null before any keys are created', async () => {
    expect(await getVapidKeys()).toBeNull()
  })

  it('generates once and stays stable across calls', async () => {
    const first = await getOrCreateVapidKeys()
    expect(first.publicKey).toBeTruthy()
    expect(first.privateKey).toBeTruthy()

    const second = await getOrCreateVapidKeys()
    expect(second).toEqual(first)
    expect(await getVapidKeys()).toEqual(first)
  })

  it('drops orphaned subscriptions when minting a fresh keypair', async () => {
    // A subscription row without a stored keypair (restored/partial backup)
    // was minted against a key we no longer have — it is undeliverable and
    // must not survive key generation.
    await upsertPushSubscription(BASE_SUB)
    expect(await listPushSubscriptions()).toHaveLength(1)

    await getOrCreateVapidKeys()

    expect(await listPushSubscriptions()).toHaveLength(0)
  })

  it('does not drop subscriptions when keys already exist', async () => {
    await getOrCreateVapidKeys()
    await upsertPushSubscription(BASE_SUB)

    await getOrCreateVapidKeys()

    expect(await listPushSubscriptions()).toHaveLength(1)
  })
})
