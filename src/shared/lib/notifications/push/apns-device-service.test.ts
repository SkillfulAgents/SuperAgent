import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import { eq } from 'drizzle-orm'
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
  upsertApnsDevice,
  listApnsDevices,
  listDeliverableApnsDevices,
  deleteApnsDeviceById,
  deleteApnsDeviceByToken,
  MAX_APNS_DEVICES_PER_OWNER,
} from './apns-device-service'

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

const BASE_DEVICE = {
  token: TOKEN_A,
  environment: 'production',
  userId: null,
  mobileDeviceId: null,
}

function tokenFor(i: number): string {
  return i.toString(16).padStart(64, '0')
}

describe('apns-device-service', () => {
  beforeEach(() => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
  })

  afterEach(() => {
    testSqlite?.close()
  })

  it('inserts a new device with defaults applied', () => {
    upsertApnsDevice({ ...BASE_DEVICE, deviceName: 'iPhone 17', workspaceTag: 'ws-1' })

    const rows = listApnsDevices()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      token: TOKEN_A,
      environment: 'production',
      userId: null,
      mobileDeviceId: null,
      workspaceTag: 'ws-1',
      deviceName: 'iPhone 17',
      platform: 'ios',
    })
  })

  it('upserts by token — re-registering refreshes metadata instead of duplicating', () => {
    upsertApnsDevice(BASE_DEVICE)
    upsertApnsDevice({
      ...BASE_DEVICE,
      environment: 'sandbox',
      deviceName: 'Renamed Phone',
      workspaceTag: 'ws-2',
    })

    const rows = listApnsDevices()
    expect(rows).toHaveLength(1)
    expect(rows[0].environment).toBe('sandbox')
    expect(rows[0].deviceName).toBe('Renamed Phone')
    expect(rows[0].workspaceTag).toBe('ws-2')
  })

  it('deletes by id', () => {
    upsertApnsDevice(BASE_DEVICE)
    const [row] = listApnsDevices()

    deleteApnsDeviceById(row.id)

    expect(listApnsDevices()).toHaveLength(0)
  })

  describe('mobileDeviceId token-rotation eviction', () => {
    function seedMobileDevices(...ids: string[]) {
      const now = new Date()
      testDb
        .insert(schema.user)
        .values({
          id: 'user-a',
          name: 'User A',
          email: 'a@example.com',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        } as never)
        .run()
      for (const id of ids) {
        testDb
          .insert(schema.mobileDevice)
          .values({
            id,
            userId: 'user-a',
            refreshTokenHash: `hash-${id}`,
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + 86_400_000),
          })
          .run()
      }
    }

    it('a new token for the same physical device evicts the rotated-away one', () => {
      seedMobileDevices('dev-1')
      upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-1' })
      upsertApnsDevice({
        ...BASE_DEVICE,
        token: TOKEN_B,
        userId: 'user-a',
        mobileDeviceId: 'dev-1',
      })

      const rows = listApnsDevices()
      expect(rows).toHaveLength(1)
      expect(rows[0].token).toBe(TOKEN_B)
    })

    it('does not evict rows belonging to a different physical device', () => {
      seedMobileDevices('dev-1', 'dev-2')
      upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-1' })
      upsertApnsDevice({
        ...BASE_DEVICE,
        token: TOKEN_B,
        userId: 'user-a',
        mobileDeviceId: 'dev-2',
      })

      expect(listApnsDevices()).toHaveLength(2)
    })

    it('a null mobileDeviceId never evicts anything', () => {
      seedMobileDevices('dev-1')
      upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-1' })
      upsertApnsDevice({ ...BASE_DEVICE, token: TOKEN_B, userId: 'user-a' })

      expect(listApnsDevices()).toHaveLength(2)
    })

    it('delivery excludes registrations whose paired device has expired', () => {
      seedMobileDevices('dev-live', 'dev-expired')
      testDb
        .update(schema.mobileDevice)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.mobileDevice.id, 'dev-expired'))
        .run()

      upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-live' })
      upsertApnsDevice({
        ...BASE_DEVICE,
        token: TOKEN_B,
        userId: 'user-a',
        mobileDeviceId: 'dev-expired',
      })
      // Defensive local-mode-parity row with no device link stays deliverable.
      upsertApnsDevice({ ...BASE_DEVICE, token: 'c'.repeat(64) })

      expect(listApnsDevices()).toHaveLength(3)
      const deliverable = listDeliverableApnsDevices()
      expect(deliverable).toHaveLength(2)
      expect(deliverable.map((d) => d.mobileDeviceId)).toEqual(
        expect.arrayContaining(['dev-live', null])
      )
    })
  })

  describe('per-owner device cap', () => {
    it('rejects a new token once the owner is at the cap; refreshing an existing one still works', () => {
      for (let i = 0; i < MAX_APNS_DEVICES_PER_OWNER; i++) {
        expect(upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(i) })).toBe(true)
      }

      expect(upsertApnsDevice({ ...BASE_DEVICE, token: 'f'.repeat(64) })).toBe(false)
      expect(listApnsDevices()).toHaveLength(MAX_APNS_DEVICES_PER_OWNER)

      // Re-upserting a token that already exists is a refresh, not growth.
      expect(
        upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(0), deviceName: 'refreshed' })
      ).toBe(true)
    })

    it('the cap is per owner, not global', () => {
      for (let i = 0; i < MAX_APNS_DEVICES_PER_OWNER; i++) {
        upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(i), userId: 'user-a' })
      }
      expect(
        upsertApnsDevice({ ...BASE_DEVICE, token: 'f'.repeat(64), userId: 'user-b' })
      ).toBe(true)
    })
  })

  describe('deleteApnsDeviceByToken owner scoping', () => {
    it('an auth-mode user cannot delete another user’s device by token', () => {
      upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a' })

      expect(deleteApnsDeviceByToken(TOKEN_A, 'user-b')).toBe(false)
      expect(listApnsDevices()).toHaveLength(1)

      expect(deleteApnsDeviceByToken(TOKEN_A, 'user-a')).toBe(true)
      expect(listApnsDevices()).toHaveLength(0)
    })

    it('local mode (no owner) deletes by token alone — including rows from a previous auth-mode life', () => {
      upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a' })

      expect(deleteApnsDeviceByToken(TOKEN_A)).toBe(true)
      expect(listApnsDevices()).toHaveLength(0)
    })

    it('returns false when nothing matches (route surfaces this as 404)', () => {
      expect(deleteApnsDeviceByToken('0'.repeat(64))).toBe(false)
    })
  })
})
