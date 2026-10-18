import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db'
import * as schema from '@shared/lib/db/schema'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { SiteStorageBundle } from '../../../agent-container/src/browser-storage-bundle'

let testDb: AppDatabase
let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

/** The agent's container: browser storage calls are recorded, and each restore waits until the test releases it. */
const container = vi.hoisted(() => {
  const calls: string[] = []
  let releaseRestore: () => void = () => {}
  let restoreStarted: () => void = () => {}
  const state = {
    calls,
    /** Resolves when the next restore starts. */
    nextRestore: () => new Promise<void>((resolve) => { restoreStarted = resolve }),
    releaseRestore: () => releaseRestore(),
    status: () => ({ status: 'running' }),
    fetch: async (url: string) => {
      const action = url.split('/').pop()!
      calls.push(action)
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
      if (action === 'status') return json({ active: true, sessionId: 'sess-1', location: 'container' })
      if (action === 'restore') {
        restoreStarted()
        await new Promise<void>((resolve) => { releaseRestore = resolve })
        return json({ cookies: 0, origins: [], sessionStorageSkipped: [] })
      }
      if (action === 'clear') return json({ skipped: [] })
      return json({})
    },
  }
  return state
})
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => ({ container }) } }))

import browserLogins from './browser-logins'
import { applyBrowserLogin, syncAgentBrowserLogins } from '@shared/lib/browser/browser-login-apply'
import { saveBrowserLogin } from '@shared/lib/services/browser-credential-service'

function bundle(theme: string): SiteStorageBundle {
  return {
    version: 1,
    site: 'example.com',
    capturedAt: '2026-10-02T00:00:00.000Z',
    cookies: [],
    origins: [{ origin: 'https://example.com', localStorage: [['theme', theme]], indexedDB: [], unsupported: [] }],
  }
}

describe('saved login changes while the browser is being written', () => {
  let dataDir: string
  const previousDataDir = process.env.SUPERAGENT_DATA_DIR

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-logins-route-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    container.calls.length = 0
    await handle.close()
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('clears the browser after the sync and does not re-create the mapping', async () => {
    const { credentialId } = await saveBrowserLogin({ userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundle('old') })
    // A save from another agent bumps the version, so agent-a's next browser open syncs it.
    await saveBrowserLogin({ userId: null, agentSlug: 'agent-b', browserType: 'container', bundle: bundle('new') })

    const restoreStarted = container.nextRestore()
    const sync = syncAgentBrowserLogins(container, 'agent-a', 'sess-1')
    await restoreStarted
    const stopUsing = browserLogins.request(`/${credentialId}/agents/agent-a`, { method: 'DELETE' })
    // Give the stop-using request every chance to run before the restore finishes.
    await new Promise((resolve) => setTimeout(resolve, 50))
    container.releaseRestore()
    const [, response] = await Promise.all([sync, stopUsing])

    expect(await response.json()).toEqual({ success: true, notCleared: [] })
    const restoreAt = container.calls.indexOf('restore')
    expect(container.calls.indexOf('clear')).toBeGreaterThan(restoreAt)
    const mappings = await testDb.select().from(schema.agentBrowserCredentials).all()
    expect(mappings.map((mapping) => mapping.agentSlug)).toEqual(['agent-b'])
  })
  const apply = (agentSlug: string, credentialId: string, userId: string | null = null) =>
    applyBrowserLogin({ client: container, sessionId: 'sess-1', agentSlug, userId, credentialId, site: 'example.com' })

  it('clears an agent the deleted login was being applied to before it was linked', async () => {
    const { credentialId } = await saveBrowserLogin({ userId: null, agentSlug: 'agent-c', browserType: 'container', bundle: bundle('old') })

    const restoreStarted = container.nextRestore()
    const applying = apply('agent-d', credentialId)
    await restoreStarted
    const deletion = browserLogins.request(`/${credentialId}`, { method: 'DELETE' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    container.releaseRestore()
    const [applied, response] = await Promise.all([applying, deletion])

    expect(applied).toEqual({ site: 'example.com', linked: false })
    expect(await response.json()).toEqual({ success: true, notCleared: [] })
    // agent-c's clear, then agent-d's once its apply finished.
    expect(container.calls.filter((call) => call === 'clear')).toHaveLength(2)
    expect(container.calls.lastIndexOf('clear')).toBeGreaterThan(container.calls.indexOf('restore'))
  })

  it('leaves a replacement login applied while the old one was deleted', async () => {
    const { credentialId: oldId } = await saveBrowserLogin({ userId: null, agentSlug: 'agent-e', browserType: 'container', bundle: bundle('old') })
    await testDb.insert(schema.user).values({ id: 'user-2', name: 'Second User', email: 'second@example.com' }).run()
    const { credentialId: newId } = await saveBrowserLogin({ userId: 'user-2', agentSlug: 'agent-f', browserType: 'container', bundle: bundle('new') })

    const restoreStarted = container.nextRestore()
    const applying = apply('agent-e', newId, 'user-2')
    await restoreStarted
    const deletion = browserLogins.request(`/${oldId}`, { method: 'DELETE' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    container.releaseRestore()
    const [applied, response] = await Promise.all([applying, deletion])

    expect(applied).toEqual({ site: 'example.com', linked: true })
    expect(await response.json()).toEqual({ success: true, notCleared: [] })
    expect(container.calls).not.toContain('clear')
    const mapping = await testDb.select().from(schema.agentBrowserCredentials).all()
    expect(mapping.find((row) => row.agentSlug === 'agent-e')?.credentialId).toBe(newId)
  })
})
