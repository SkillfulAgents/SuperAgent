import crypto from 'crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { browserAccounts } from '@shared/lib/db/schema'
import { installTestKeyManager, uninstallKeyManager, type MemoryKeyManager } from '@shared/lib/keys/testing/memory-key-manager'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const { saveAccount } = await import('./vault-service')
const { probeVaultKey } = await import('./vault-key-probe')

let handle: TestDatabase
let keys: MemoryKeyManager

beforeAll(async () => {
  keys = await installTestKeyManager()
})

afterAll(() => {
  uninstallKeyManager()
})

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
})

afterEach(async () => {
  await handle.close()
})

const github = { owner: null, site: 'github.com', origin: 'https://github.com' }
const randomKey = () => crypto.createSecretKey(crypto.randomBytes(32))

describe('probeVaultKey', () => {
  it('finds nothing sealed in an empty vault, or one whose accounts hold no secret part', async () => {
    expect(await probeVaultKey(randomKey())).toBe('nothing-sealed')
    await saveAccount({ ...github, username: 'name-only' })
    expect(await probeVaultKey(randomKey())).toBe('nothing-sealed')
  })

  it('tells the key the vault sealed with from another', async () => {
    await saveAccount({ ...github, username: 'octocat', values: { password: 'pw' } })
    expect(await probeVaultKey(await keys.key('browser-vault'))).toBe('opens')
    expect(await probeVaultKey(randomKey())).toBe('does-not-open')
  })

  it('does not read one damaged row, or an old one under a lost key, as a wrong key', async () => {
    const current = await keys.key('browser-vault')
    const { account: damaged } = await saveAccount({ ...github, username: 'damaged', values: { password: 'a' } })
    await saveAccount({ ...github, username: 'fine', values: { password: 'b' } })
    await testDb.update(browserAccounts).set({ secrets: 'v1:AAAA:AAAA:AAAA', updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(browserAccounts.id, damaged.id)).run()
    expect(await probeVaultKey(current)).toBe('opens')
  })
})
