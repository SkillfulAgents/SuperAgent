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

import { saveBrowserLogin } from './browser-credential-service'

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

  it('keeps one login per owner, site and browser type when two saves race', async () => {
    const results = await Promise.allSettled([
      saveBrowserLogin({ userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundleFor('example.com', 'dark') }),
      saveBrowserLogin({ userId: null, agentSlug: 'agent-b', browserType: 'container', bundle: bundleFor('example.com', 'light') }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(credentials()).toHaveLength(1)
  })
})
