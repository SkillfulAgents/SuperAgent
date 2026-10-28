import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../../db/schema'
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
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts a new device with defaults applied', async () => {
    await upsertApnsDevice({ ...BASE_DEVICE, deviceName: 'iPhone 17', workspaceTag: 'ws-1' })

    const rows = await listApnsDevices()
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

  it('upserts by token — re-registering refreshes metadata instead of duplicating', async () => {
    await upsertApnsDevice(BASE_DEVICE)
    await upsertApnsDevice({
      ...BASE_DEVICE,
      environment: 'sandbox',
      deviceName: 'Renamed Phone',
      workspaceTag: 'ws-2',
    })

    const rows = await listApnsDevices()
    expect(rows).toHaveLength(1)
    expect(rows[0].environment).toBe('sandbox')
    expect(rows[0].deviceName).toBe('Renamed Phone')
    expect(rows[0].workspaceTag).toBe('ws-2')
  })

  it('deletes by id', async () => {
    await upsertApnsDevice(BASE_DEVICE)
    const [row] = await listApnsDevices()

    await deleteApnsDeviceById(row.id)

    expect(await listApnsDevices()).toHaveLength(0)
  })

  describe('mobileDeviceId token-rotation eviction', () => {
    async function seedMobileDevices(...ids: string[]) {
      const now = new Date()
      await testDb
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
        await testDb
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

    it('a new token for the same physical device evicts the rotated-away one', async () => {
      await seedMobileDevices('dev-1')
      await upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-1' })
      await upsertApnsDevice({
        ...BASE_DEVICE,
        token: TOKEN_B,
        userId: 'user-a',
        mobileDeviceId: 'dev-1',
      })

      const rows = await listApnsDevices()
      expect(rows).toHaveLength(1)
      expect(rows[0].token).toBe(TOKEN_B)
    })

    it('does not evict rows belonging to a different physical device', async () => {
      await seedMobileDevices('dev-1', 'dev-2')
      await upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-1' })
      await upsertApnsDevice({
        ...BASE_DEVICE,
        token: TOKEN_B,
        userId: 'user-a',
        mobileDeviceId: 'dev-2',
      })

      expect(await listApnsDevices()).toHaveLength(2)
    })

    it('a null mobileDeviceId never evicts anything', async () => {
      await seedMobileDevices('dev-1')
      await upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-1' })
      await upsertApnsDevice({ ...BASE_DEVICE, token: TOKEN_B, userId: 'user-a' })

      expect(await listApnsDevices()).toHaveLength(2)
    })

    it('delivery excludes registrations whose paired device has expired', async () => {
      await seedMobileDevices('dev-live', 'dev-expired')
      await testDb
        .update(schema.mobileDevice)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.mobileDevice.id, 'dev-expired'))
        .run()

      await upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a', mobileDeviceId: 'dev-live' })
      await upsertApnsDevice({
        ...BASE_DEVICE,
        token: TOKEN_B,
        userId: 'user-a',
        mobileDeviceId: 'dev-expired',
      })
      // Defensive local-mode-parity row with no device link stays deliverable.
      await upsertApnsDevice({ ...BASE_DEVICE, token: 'c'.repeat(64) })

      expect(await listApnsDevices()).toHaveLength(3)
      const deliverable = await listDeliverableApnsDevices()
      expect(deliverable).toHaveLength(2)
      expect(deliverable.map((d) => d.mobileDeviceId)).toEqual(
        expect.arrayContaining(['dev-live', null])
      )
    })
  })

  describe('per-owner device cap', () => {
    it('rejects a new token once the owner is at the cap; refreshing an existing one still works', async () => {
      for (let i = 0; i < MAX_APNS_DEVICES_PER_OWNER; i++) {
        expect(await upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(i) })).toBe(true)
      }

      expect(await upsertApnsDevice({ ...BASE_DEVICE, token: 'f'.repeat(64) })).toBe(false)
      expect(await listApnsDevices()).toHaveLength(MAX_APNS_DEVICES_PER_OWNER)

      // Re-upserting a token that already exists is a refresh, not growth.
      expect(
        await upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(0), deviceName: 'refreshed' })
      ).toBe(true)
    })

    it('the cap is per owner, not global', async () => {
      for (let i = 0; i < MAX_APNS_DEVICES_PER_OWNER; i++) {
        await upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(i), userId: 'user-a' })
      }
      expect(
        await upsertApnsDevice({ ...BASE_DEVICE, token: 'f'.repeat(64), userId: 'user-b' })
      ).toBe(true)
    })

    it('two concurrent registrations with one slot left admit exactly one', async () => {
      for (let i = 0; i < MAX_APNS_DEVICES_PER_OWNER - 1; i++) {
        await upsertApnsDevice({ ...BASE_DEVICE, token: tokenFor(i) })
      }

      const admitted = await Promise.all([
        upsertApnsDevice({ ...BASE_DEVICE, token: 'a'.repeat(64) }),
        upsertApnsDevice({ ...BASE_DEVICE, token: 'b'.repeat(64) }),
      ])

      expect(admitted.filter(Boolean)).toHaveLength(1)
      expect(await listApnsDevices()).toHaveLength(MAX_APNS_DEVICES_PER_OWNER)
    })
  })

  describe('deleteApnsDeviceByToken owner scoping', () => {
    it('an auth-mode user cannot delete another user’s device by token', async () => {
      await upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a' })

      expect(await deleteApnsDeviceByToken(TOKEN_A, 'user-b')).toBe(false)
      expect(await listApnsDevices()).toHaveLength(1)

      expect(await deleteApnsDeviceByToken(TOKEN_A, 'user-a')).toBe(true)
      expect(await listApnsDevices()).toHaveLength(0)
    })

    it('local mode (no owner) deletes by token alone — including rows from a previous auth-mode life', async () => {
      await upsertApnsDevice({ ...BASE_DEVICE, userId: 'user-a' })

      expect(await deleteApnsDeviceByToken(TOKEN_A)).toBe(true)
      expect(await listApnsDevices()).toHaveLength(0)
    })

    it('returns false when nothing matches (route surfaces this as 404)', async () => {
      expect(await deleteApnsDeviceByToken('0'.repeat(64))).toBe(false)
    })
  })
})
