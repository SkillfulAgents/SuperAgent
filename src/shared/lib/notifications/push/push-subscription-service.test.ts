import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../db/schema'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../../db', () => ({
  get db() {
    return testDb
  },
  get sqlite() {
    return testSqlite
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
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('inserts a new subscription', () => {
    upsertPushSubscription({ ...BASE_SUB, deviceName: 'iPhone' })

    const rows = listPushSubscriptions()
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

  it('upserts by endpoint — re-subscribing refreshes keys/origin instead of duplicating', () => {
    upsertPushSubscription(BASE_SUB)
    upsertPushSubscription({
      ...BASE_SUB,
      p256dh: 'rotated-p256dh',
      origin: 'https://192.168.1.10:3000',
    })

    const rows = listPushSubscriptions()
    expect(rows).toHaveLength(1)
    expect(rows[0].keysP256dh).toBe('rotated-p256dh')
    expect(rows[0].origin).toBe('https://192.168.1.10:3000')
  })

  it('deletes by id', () => {
    upsertPushSubscription(BASE_SUB)
    const [row] = listPushSubscriptions()

    deletePushSubscriptionById(row.id)

    expect(listPushSubscriptions()).toHaveLength(0)
  })

  describe('per-owner subscription cap', () => {
    it('rejects a new endpoint once the owner is at the cap; refreshing an existing one still works', () => {
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_OWNER; i++) {
        expect(
          upsertPushSubscription({ ...BASE_SUB, endpoint: `https://push.example/dev-${i}` })
        ).toBe(true)
      }

      expect(
        upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/one-too-many' })
      ).toBe(false)
      expect(listPushSubscriptions()).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_OWNER)

      // Re-upserting an endpoint that already exists is a refresh, not growth.
      expect(
        upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/dev-0', p256dh: 'new' })
      ).toBe(true)
    })

    it('the cap is per owner, not global', () => {
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_OWNER; i++) {
        upsertPushSubscription({ ...BASE_SUB, endpoint: `https://push.example/a-${i}`, userId: 'user-a' })
      }
      expect(
        upsertPushSubscription({ ...BASE_SUB, endpoint: 'https://push.example/b-0', userId: 'user-b' })
      ).toBe(true)
    })
  })

  describe('deletePushSubscriptionByEndpoint owner scoping', () => {
    it('an auth-mode user cannot delete another user’s subscription by endpoint', () => {
      upsertPushSubscription({ ...BASE_SUB, userId: 'user-a' })

      expect(deletePushSubscriptionByEndpoint(BASE_SUB.endpoint, 'user-b')).toBe(false)
      expect(listPushSubscriptions()).toHaveLength(1)

      expect(deletePushSubscriptionByEndpoint(BASE_SUB.endpoint, 'user-a')).toBe(true)
      expect(listPushSubscriptions()).toHaveLength(0)
    })

    it('local mode (no owner) deletes by endpoint alone — including rows from a previous auth-mode life', () => {
      upsertPushSubscription({ ...BASE_SUB, userId: 'user-a' })

      expect(deletePushSubscriptionByEndpoint(BASE_SUB.endpoint)).toBe(true)
      expect(listPushSubscriptions()).toHaveLength(0)
    })

    it('returns false when nothing matches (route surfaces this as 404)', () => {
      expect(deletePushSubscriptionByEndpoint('https://push.example/nope')).toBe(false)
    })
  })
})

describe('vapid-keys', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('returns null before any keys are created', () => {
    expect(getVapidKeys()).toBeNull()
  })

  it('generates once and stays stable across calls', () => {
    const first = getOrCreateVapidKeys()
    expect(first.publicKey).toBeTruthy()
    expect(first.privateKey).toBeTruthy()

    const second = getOrCreateVapidKeys()
    expect(second).toEqual(first)
    expect(getVapidKeys()).toEqual(first)
  })

  it('drops orphaned subscriptions when minting a fresh keypair', () => {
    // A subscription row without a stored keypair (restored/partial backup)
    // was minted against a key we no longer have — it is undeliverable and
    // must not survive key generation.
    upsertPushSubscription(BASE_SUB)
    expect(listPushSubscriptions()).toHaveLength(1)

    getOrCreateVapidKeys()

    expect(listPushSubscriptions()).toHaveLength(0)
  })

  it('does not drop subscriptions when keys already exist', () => {
    getOrCreateVapidKeys()
    upsertPushSubscription(BASE_SUB)

    getOrCreateVapidKeys()

    expect(listPushSubscriptions()).toHaveLength(1)
  })
})
