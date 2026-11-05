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
import { insertRecordIfAbsent, InvalidAppRecordError, readStoredRecord } from './records'
import { AUTH_SECRET_RECORD_KEY, TENANT_ID_RECORD_KEY, hostContainerTokenKey } from './record-schemas'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { getOrCreateHostToken } from '@shared/lib/container/host-token-store'
import { getOrCreatePlatformClientInstanceId } from '@shared/lib/services/platform-device-service'

let dir: string
let a: TestDatabase
let b: TestDatabase

beforeEach(async () => {
  vi.stubEnv('BETTER_AUTH_SECRET', '')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-records-'))
  const file = path.join(dir, 'shared.db')
  a = await createTestDatabase({ file })
  b = await createTestDatabase({ file })
})
afterEach(async () => {
  await a.close()
  await b.close()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Calls alternating between the two processes' database handles, all at once. */
function fromBoth<T>(n: number, call: (db: TestDatabase['db']) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => call(i % 2 ? a.db : b.db)))
}

describe('simultaneous first use on an empty database', () => {
  it('agrees on one tenant id', async () => {
    const ids = await fromBoth(10, (db) => getTenantId(db))
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('agrees on one auth secret', async () => {
    const secrets = await fromBoth(10, (db) => getOrCreateAuthSecret(db))
    expect(new Set(secrets).size).toBe(1)
    expect(secrets[0].length).toBeGreaterThanOrEqual(32)
  })

  it('agrees on one token per agent and keeps every agent’s token', async () => {
    const [sameAgent, other] = await Promise.all([
      fromBoth(10, (db) => getOrCreateHostToken('alpha', db)),
      fromBoth(10, (db) => getOrCreateHostToken('beta', db)),
    ])
    expect(new Set(sameAgent).size).toBe(1)
    expect(new Set(other).size).toBe(1)
    expect(sameAgent[0]).not.toBe(other[0])
    expect(await getOrCreateHostToken('alpha', a.db)).toBe(sameAgent[0])
    expect(await getOrCreateHostToken('beta', b.db)).toBe(other[0])
  })

  it('agrees on one platform client instance id', async () => {
    const ids = await fromBoth(6, (db) => getOrCreatePlatformClientInstanceId(db))
    expect(new Set(ids).size).toBe(1)
  })
})

describe('an existing deployment', () => {
  it('a process starting on a populated database reads the records, never regenerates them', async () => {
    const tenant = await getTenantId(a.db)
    const secret = await getOrCreateAuthSecret(a.db)
    const token = await getOrCreateHostToken('alpha', a.db)
    // A new process (fresh handle, nothing in memory) on the same database.
    const cold = await createTestDatabase({ file: path.join(dir, 'shared.db') })
    try {
      expect(await getTenantId(cold.db)).toBe(tenant)
      expect(await getOrCreateAuthSecret(cold.db)).toBe(secret)
      expect(await getOrCreateHostToken('alpha', cold.db)).toBe(token)
    } finally {
      await cold.close()
    }
  })

  it('BETTER_AUTH_SECRET wins over the stored secret and creates nothing', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'from-the-environment-and-long-enough-0000')
    expect(await getOrCreateAuthSecret(a.db)).toBe('from-the-environment-and-long-enough-0000')
    expect(await readStoredRecord(AUTH_SECRET_RECORD_KEY, a.db)).toBeNull()
  })

  it('an invalid stored identity throws and is not replaced', async () => {
    await insertRecordIfAbsent(AUTH_SECRET_RECORD_KEY, JSON.stringify('too-short'), a.db)
    await insertRecordIfAbsent(TENANT_ID_RECORD_KEY, JSON.stringify(''), a.db)
    await insertRecordIfAbsent(hostContainerTokenKey('alpha'), '{not json', a.db)
    await expect(getOrCreateAuthSecret(a.db)).rejects.toThrow(InvalidAppRecordError)
    await expect(getTenantId(a.db)).rejects.toThrow(InvalidAppRecordError)
    await expect(getOrCreateHostToken('alpha', a.db)).rejects.toThrow(InvalidAppRecordError)
    expect((await readStoredRecord(AUTH_SECRET_RECORD_KEY, a.db))?.value).toBe(JSON.stringify('too-short'))
  })

  it('a database error is not absence: nothing is generated', async () => {
    // Every read on this process's handle fails.
    vi.spyOn(a.db, 'select').mockImplementation(() => {
      throw new Error('SQLITE_BUSY')
    })
    const insert = vi.spyOn(a.db, 'insert')
    await expect(getTenantId(a.db)).rejects.toThrow('SQLITE_BUSY')
    await expect(getOrCreateHostToken('alpha', a.db)).rejects.toThrow('SQLITE_BUSY')
    expect(insert).not.toHaveBeenCalled()
  })
})
