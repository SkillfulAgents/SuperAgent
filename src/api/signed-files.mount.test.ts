/**
 * The signed files router as the real app mounts it (src/api/index.ts), in
 * auth mode: a request that carries only the URL, no session cookie or
 * bearer, reaches it, while a session-guarded route next to it refuses the
 * same request.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { agentAcl, agents, user } from '@shared/lib/db/schema'
import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'

// src/api/index.ts reads the mode once, when it is imported.
vi.hoisted(() => { process.env.AUTH_MODE = 'true' })

let handle: TestDatabase
let root: string
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('@shared/lib/auth/config', async (original) => ({
  ...(await original<typeof import('@shared/lib/auth/config')>()),
  getAppBaseUrl: async () => 'https://gamut.test',
}))
vi.mock('@shared/lib/agent-actor/registry', async (original) => ({
  ...(await original<typeof import('@shared/lib/agent-actor/registry')>()),
  agentRegistry: { get: (slug: string) => ({ files: new LocalFileOps(() => path.join(root, slug)) }) },
}))

import app from './index'
import { mintSignedDownloadUrl } from '@shared/lib/signed-file-urls/signed-file-urls'

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signed-files-app-')))
  fs.mkdirSync(path.join(root, 'agent'))
  fs.writeFileSync(path.join(root, 'agent', 'a.txt'), 'through the real app')
  handle = await createTestDatabase()
  await handle.db.insert(user).values({ id: 'alice', name: 'Alice', email: 'alice@example.com' }).run()
  await handle.db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
  await handle.db.insert(agentAcl).values({ id: 'acl', userId: 'alice', agentSlug: 'agent', role: 'viewer', createdAt: new Date() }).run()
})

afterAll(async () => {
  await backgroundSettled()
  await handle.close()
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.AUTH_MODE
})

describe('signed files in the real app, auth mode', () => {
  it('serves a signed URL to a request with no session', async () => {
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'a.txt' })
    const response = await app.request(new URL(url).pathname)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('through the real app')
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect((await app.request('/api/signed-files/forged.token')).status).toBe(401)
  })

  it('while the same request to the session-guarded file route is refused', async () => {
    expect((await app.request('/api/agents/agent/files/a.txt')).status).toBe(401)
  })
})
