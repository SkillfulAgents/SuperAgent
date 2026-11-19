import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mutateSettings } from '@shared/lib/config/settings'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import {
  clearCloudWorkspaceRecord,
  readCloudWorkspaceRecord,
  writeCloudWorkspaceRecord,
} from './cloud-workspace-record'

const RECORD = {
  deploymentUrl: 'https://ws.example.com',
  orgId: 'org_1',
  token: 'deploy_session_token',
  tokenPreview: 'deploy...oken',
  expiresAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
  userId: 'usr_1',
  memberId: 'sub_1',
  tokenFingerprint: 'fp_1',
}

// Settings (where the record lives) are in the app database: a fresh test database per test.
let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

describe('cloud-workspace record', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })
  afterEach(async () => {
    await handle.close()
  })

  it('writes, reads back and clears the record', async () => {
    expect(await writeCloudWorkspaceRecord(RECORD)).toBe(true)
    expect(await readCloudWorkspaceRecord()).toEqual(RECORD)

    await clearCloudWorkspaceRecord()
    expect(await readCloudWorkspaceRecord()).toBeNull()
  })

  it('writes only when the guard passes on the settings it would replace', async () => {
    await mutateSettings((settings) => {
      settings.platformAuth = undefined
    })

    expect(await writeCloudWorkspaceRecord(RECORD, { onlyIf: (settings) => Boolean(settings.platformAuth) })).toBe(false)
    expect(await readCloudWorkspaceRecord()).toBeNull()

    expect(await writeCloudWorkspaceRecord(RECORD, { onlyIf: (settings) => !settings.platformAuth })).toBe(true)
    expect(await readCloudWorkspaceRecord()).toEqual(RECORD)
  })

  it('leaves the record when the clear guard refuses', async () => {
    await writeCloudWorkspaceRecord(RECORD)

    await clearCloudWorkspaceRecord({ onlyIf: () => false })

    expect(await readCloudWorkspaceRecord()).toEqual(RECORD)
  })
})
