import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { SiteStorageBundle } from '../../../../agent-container/src/browser-storage-bundle'
import { decryptBrowserBundle } from '../browser/browser-vault-crypto'

let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
}))

import {
  deleteBrowserLogin,
  getOwnedBrowserLogin,
  listBrowserLogins,
  listManagedBrowserLogins,
  listOutdatedAgentBrowserLogins,
  mapAgentToBrowserLogin,
  renameBrowserLogin,
  saveBrowserLogin,
  unmapBrowserLogin,
} from './browser-credential-service'

function bundleFor(site: string, theme: string): SiteStorageBundle {
  return {
    version: 1,
    site,
    capturedAt: '2026-09-28T00:00:00.000Z',
    cookies: [],
    origins: [{ origin: `https://${site}`, localStorage: [['theme', theme]], indexedDB: [], unsupported: [] }],
  }
}

function insertUser(id: string): void {
  testSqlite.prepare(
    'INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0)',
  ).run(id, id, `${id}@example.com`)
}

function credentials() {
  return testDb.select().from(schema.browserCredentials).all()
}

function mapping(agentSlug: string, site: string) {
  return testDb.select().from(schema.agentBrowserCredentials)
    .where(eq(schema.agentBrowserCredentials.agentSlug, agentSlug))
    .all()
    .find((row) => row.site === site)
}

describe('saveBrowserLogin', () => {
  let dataDir: string
  const previousDataDir = process.env.SUPERAGENT_DATA_DIR

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-credential-service-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    testSqlite = new Database(':memory:')
    testSqlite.pragma('foreign_keys = ON')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    insertUser('alice')
    insertUser('bob')
  })

  afterEach(() => {
    testSqlite.close()
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates an encrypted credential and maps the agent to it', async () => {
    const result = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })

    expect(result).toMatchObject({ status: 'created', version: 1 })
    const [row] = credentials()
    expect(row).toMatchObject({ userId: 'alice', name: 'example.com', site: 'example.com', browserType: 'container', version: 1 })
    expect(row.bundle).not.toContain('dark')
    expect(decryptBrowserBundle(row.bundle, row)).toEqual(bundleFor('example.com', 'dark'))
    expect(mapping('agent-a', 'example.com')).toMatchObject({ credentialId: row.id, appliedVersion: 1 })
  })

  it('overwrites the user\'s login for the site from any agent and bumps its version', async () => {
    const first = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    const second = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-b', browserType: 'container', bundle: bundleFor('example.com', 'light'),
    })

    expect(second).toEqual({ status: 'updated', credentialId: first.credentialId, version: 2 })
    const [row] = credentials()
    expect(credentials()).toHaveLength(1)
    expect(row.version).toBe(2)
    expect(decryptBrowserBundle(row.bundle, row)).toEqual(bundleFor('example.com', 'light'))
    expect(mapping('agent-a', 'example.com')).toMatchObject({ credentialId: first.credentialId, appliedVersion: 1 })
    expect(mapping('agent-b', 'example.com')).toMatchObject({ credentialId: first.credentialId, appliedVersion: 2 })
  })

  it('never overwrites another user\'s login on a shared agent', async () => {
    const alice = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    const bob = await saveBrowserLogin({
      userId: 'bob', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'light'),
    })

    expect(bob.status).toBe('created')
    expect(bob.credentialId).not.toBe(alice.credentialId)
    const aliceRow = credentials().find((row) => row.id === alice.credentialId)!
    expect(aliceRow.version).toBe(1)
    expect(decryptBrowserBundle(aliceRow.bundle, aliceRow)).toEqual(bundleFor('example.com', 'dark'))
    expect(mapping('agent-a', 'example.com')).toMatchObject({ credentialId: bob.credentialId })
  })

  it('creates a new credential when the browser type differs', async () => {
    const container = await saveBrowserLogin({
      userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    const chrome = await saveBrowserLogin({
      userId: null, agentSlug: 'agent-a', browserType: 'chrome', bundle: bundleFor('example.com', 'dark'),
    })

    expect(chrome.status).toBe('created')
    expect(chrome.credentialId).not.toBe(container.credentialId)
    expect(credentials()).toHaveLength(2)
  })

  it('lists and reads only the caller\'s logins for the site and browser type', async () => {
    const alice = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    await saveBrowserLogin({
      userId: 'bob', agentSlug: 'agent-b', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-c', browserType: 'chrome', bundle: bundleFor('example.com', 'dark'),
    })
    await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-d', browserType: 'container', bundle: bundleFor('other.com', 'dark'),
    })

    const listed = await listBrowserLogins({ userId: 'alice', site: 'example.com', browserType: 'container' })
    expect(listed.map((login) => login.id)).toEqual([alice.credentialId])
    expect(listed[0]).not.toHaveProperty('bundle')
    expect(await getOwnedBrowserLogin('alice', alice.credentialId)).toMatchObject({ id: alice.credentialId })
    expect(await getOwnedBrowserLogin('bob', alice.credentialId)).toBeUndefined()
  })

  it('maps an agent to a login, replacing its previous login for the site', async () => {
    const first = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    const second = await saveBrowserLogin({
      userId: 'bob', agentSlug: 'agent-b', browserType: 'container', bundle: bundleFor('example.com', 'light'),
    })

    await mapAgentToBrowserLogin({ agentSlug: 'agent-a', credentialId: second.credentialId, site: 'example.com', version: 1 })

    expect(mapping('agent-a', 'example.com')).toMatchObject({ credentialId: second.credentialId, appliedVersion: 1 })
    expect(first.credentialId).not.toBe(second.credentialId)
  })

  it('lists the caller\'s logins with the agents using them', async () => {
    testSqlite.prepare('INSERT INTO agents (slug, name, created_at) VALUES (?, ?, 0)').run('agent-a', 'Research')
    const saved = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    await mapAgentToBrowserLogin({ agentSlug: 'agent-b', credentialId: saved.credentialId, site: 'example.com', version: 1 })
    await saveBrowserLogin({ userId: 'bob', agentSlug: 'agent-c', browserType: 'container', bundle: bundleFor('example.com', 'dark') })

    const [login, ...rest] = await listManagedBrowserLogins('alice')
    expect(rest).toHaveLength(0)
    expect(login).toMatchObject({ id: saved.credentialId, site: 'example.com', version: 1 })
    expect(login).not.toHaveProperty('bundle')
    expect(login.agents).toEqual(expect.arrayContaining([
      { slug: 'agent-a', name: 'Research' },
      { slug: 'agent-b', name: 'agent-b' },
    ]))
  })

  it('renames, unmaps and deletes only the caller\'s logins', async () => {
    const saved = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    await mapAgentToBrowserLogin({ agentSlug: 'agent-b', credentialId: saved.credentialId, site: 'example.com', version: 1 })

    expect(await renameBrowserLogin('bob', saved.credentialId, 'Stolen')).toBe(false)
    expect(await renameBrowserLogin('alice', saved.credentialId, 'Work')).toBe(true)
    expect((await getOwnedBrowserLogin('alice', saved.credentialId))?.name).toBe('Work')

    expect(await unmapBrowserLogin('bob', saved.credentialId, 'agent-b')).toBeNull()
    expect(await unmapBrowserLogin('alice', saved.credentialId, 'agent-b'))
      .toEqual({ site: 'example.com', origins: ['https://example.com'] })
    expect(mapping('agent-b', 'example.com')).toBeUndefined()

    expect(await deleteBrowserLogin('bob', saved.credentialId)).toBeNull()
    expect(await deleteBrowserLogin('alice', saved.credentialId)).toEqual({
      site: 'example.com', origins: ['https://example.com'], agentSlugs: ['agent-a'],
    })
    expect(credentials()).toHaveLength(0)
    expect(mapping('agent-a', 'example.com')).toBeUndefined()
  })

  it('deletes a login whose bundle no longer decrypts', async () => {
    const saved = await saveBrowserLogin({
      userId: 'alice', agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    fs.writeFileSync(path.join(dataDir, 'browser-vault.key'), Buffer.alloc(32, 7).toString('base64'))

    expect(await deleteBrowserLogin('alice', saved.credentialId)).toEqual({
      site: 'example.com', origins: [], agentSlugs: ['agent-a'],
    })
    expect(credentials()).toHaveLength(0)
  })

  it('lists mapped logins with a newer version than the agent has', async () => {
    const saved = await saveBrowserLogin({
      userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark'),
    })
    await mapAgentToBrowserLogin({ agentSlug: 'agent-b', credentialId: saved.credentialId, site: 'example.com', version: 1 })
    await saveBrowserLogin({ userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'light') })

    expect(await listOutdatedAgentBrowserLogins('agent-a', 'container')).toEqual([])
    expect((await listOutdatedAgentBrowserLogins('agent-b', 'container')).map((row) => row.version)).toEqual([2])
    expect(await listOutdatedAgentBrowserLogins('agent-b', 'chrome')).toEqual([])
  })

  it('keeps one login per owner, site and browser type when two saves race', async () => {
    const results = await Promise.allSettled([
      saveBrowserLogin({ userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark') }),
      saveBrowserLogin({ userId: null, agentSlug: 'agent-b', browserType: 'container', bundle: bundleFor('example.com', 'light') }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(credentials()).toHaveLength(1)
  })
})
