/**
 * The identities a deployment creates once (tenant id, auth secret, host
 * container tokens, platform client instance id), created concurrently by
 * two processes on one empty database: every caller returns the committed
 * value. Runs on the test driver (DB_DRIVER=libsql for libsql).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { dbAppRecordStore, type AppRecordStore } from './record-store'
import { InvalidAppRecordError } from './records'
import { AUTH_SECRET_RECORD_KEY, TENANT_ID_RECORD_KEY, hostContainerTokenKey } from './record-schemas'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { getOrCreateHostToken } from '@shared/lib/container/host-token-store'
import { getOrCreatePlatformClientInstanceId } from '@shared/lib/services/platform-device-service'

let dir: string
let a: TestDatabase
let b: TestDatabase
let storeA: AppRecordStore
let storeB: AppRecordStore

beforeEach(async () => {
  vi.stubEnv('BETTER_AUTH_SECRET', '')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-records-'))
  const file = path.join(dir, 'shared.db')
  a = await createTestDatabase({ file })
  b = await createTestDatabase({ file })
  storeA = dbAppRecordStore(a.db)
  storeB = dbAppRecordStore(b.db)
})
afterEach(async () => {
  await a.close()
  await b.close()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Calls alternating between the two processes' stores, all at once. */
function fromBoth<T>(n: number, call: (store: AppRecordStore) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => call(i % 2 ? storeA : storeB)))
}

describe('simultaneous first use on an empty database', () => {
  it('agrees on one tenant id', async () => {
    const ids = await fromBoth(10, (store) => getTenantId(store))
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('agrees on one auth secret', async () => {
    const secrets = await fromBoth(10, (store) => getOrCreateAuthSecret(store))
    expect(new Set(secrets).size).toBe(1)
    expect(secrets[0].length).toBeGreaterThanOrEqual(32)
  })

  it('agrees on one token per agent and keeps every agent’s token', async () => {
    const [sameAgent, other] = await Promise.all([
      fromBoth(10, (store) => getOrCreateHostToken('alpha', store)),
      fromBoth(10, (store) => getOrCreateHostToken('beta', store)),
    ])
    expect(new Set(sameAgent).size).toBe(1)
    expect(new Set(other).size).toBe(1)
    expect(sameAgent[0]).not.toBe(other[0])
    expect(await getOrCreateHostToken('alpha', storeA)).toBe(sameAgent[0])
    expect(await getOrCreateHostToken('beta', storeB)).toBe(other[0])
  })

  it('agrees on one platform client instance id', async () => {
    const ids = await fromBoth(6, (store) => getOrCreatePlatformClientInstanceId(store))
    expect(new Set(ids).size).toBe(1)
  })
})

describe('an existing deployment', () => {
  it('a process starting on a populated database reads the records, never regenerates them', async () => {
    const tenant = await getTenantId(storeA)
    const secret = await getOrCreateAuthSecret(storeA)
    const token = await getOrCreateHostToken('alpha', storeA)
    // A new process (fresh handle, nothing in memory) on the same database.
    const cold = await createTestDatabase({ file: path.join(dir, 'shared.db') })
    try {
      const coldStore = dbAppRecordStore(cold.db)
      expect(await getTenantId(coldStore)).toBe(tenant)
      expect(await getOrCreateAuthSecret(coldStore)).toBe(secret)
      expect(await getOrCreateHostToken('alpha', coldStore)).toBe(token)
    } finally {
      await cold.close()
    }
  })

  it('BETTER_AUTH_SECRET wins over the stored secret and creates nothing', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'from-the-environment-and-long-enough-0000')
    expect(await getOrCreateAuthSecret(storeA)).toBe('from-the-environment-and-long-enough-0000')
    expect(await storeA.read(AUTH_SECRET_RECORD_KEY)).toBeNull()
  })

  it('an invalid stored identity throws and is not replaced', async () => {
    await storeA.insertIfAbsent(AUTH_SECRET_RECORD_KEY, JSON.stringify('too-short'))
    await storeA.insertIfAbsent(TENANT_ID_RECORD_KEY, JSON.stringify(''))
    await storeA.insertIfAbsent(hostContainerTokenKey('alpha'), '{not json')
    await expect(getOrCreateAuthSecret(storeA)).rejects.toThrow(InvalidAppRecordError)
    await expect(getTenantId(storeA)).rejects.toThrow(InvalidAppRecordError)
    await expect(getOrCreateHostToken('alpha', storeA)).rejects.toThrow(InvalidAppRecordError)
    expect((await storeA.read(AUTH_SECRET_RECORD_KEY))?.value).toBe(JSON.stringify('too-short'))
  })

  it('a database error is not absence: nothing is generated', async () => {
    vi.spyOn(storeA, 'read').mockRejectedValue(new Error('SQLITE_BUSY'))
    const insert = vi.spyOn(storeA, 'insertIfAbsent')
    await expect(getTenantId(storeA)).rejects.toThrow('SQLITE_BUSY')
    await expect(getOrCreateHostToken('alpha', storeA)).rejects.toThrow('SQLITE_BUSY')
    expect(insert).not.toHaveBeenCalled()
  })
})
