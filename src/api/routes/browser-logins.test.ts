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

/** The agent's container: browser storage calls are recorded, and restore waits until the test releases it. */
const container = vi.hoisted(() => {
  const calls: string[] = []
  let releaseRestore: () => void = () => {}
  let restoreStarted: () => void = () => {}
  const state = {
    calls,
    restoreStarted: new Promise<void>((resolve) => { restoreStarted = resolve }),
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
import { syncAgentBrowserLogins } from '@shared/lib/browser/browser-login-apply'
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

describe('stop using a saved login while a sync is restoring it', () => {
  let dataDir: string
  const previousDataDir = process.env.SUPERAGENT_DATA_DIR

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-logins-route-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    await handle.close()
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('clears the browser after the sync and does not re-create the mapping', async () => {
    const { credentialId } = await saveBrowserLogin({ userId: null, agentSlug: 'agent-a', browserType: 'container', bundle: bundle('old') })
    // A save from another agent bumps the version, so agent-a's next browser open syncs it.
    await saveBrowserLogin({ userId: null, agentSlug: 'agent-b', browserType: 'container', bundle: bundle('new') })

    const sync = syncAgentBrowserLogins(container, 'agent-a', 'sess-1')
    await container.restoreStarted
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
})
