import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { runtimeCapabilities } from '@shared/lib/facts/capabilities'
import { declareServerCapabilities } from '@shared/lib/facts/server-facts'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { agentAcl, agents, user, volumeAcl } from '@shared/lib/db/schema'
import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'
import { createVolumeDefinition } from '@shared/lib/services/volume-service'

let handle: TestDatabase
let root: string
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('@shared/lib/auth/config', async (original) => ({
  ...(await original<typeof import('@shared/lib/auth/config')>()),
  getAppBaseUrl: async () => 'https://gamut.test',
}))
// A small per-request cap, so an oversized body is cheap to send.
vi.mock('@shared/lib/utils/chunked-upload', async (original) => ({
  ...(await original<typeof import('@shared/lib/utils/chunked-upload')>()),
  MAX_UPLOAD_REQUEST_SIZE: 1024,
}))
const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@shared/lib/services/audit-log-service', () => audit)
// Each agent's workspace is a real directory; one session delivered `out/report.txt`.
const deliveries = vi.hoisted(() => ({ sizeBytes: 0 }))
vi.mock('@shared/lib/agent-actor/registry', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      files: new LocalFileOps(() => path.join(root, slug)),
      sessions: { isKnown: async (sessionId: string) => sessionId === 's1' },
      messages: {
        findDeliveredFile: async (_sessionId: string, deliveryId: string) => deliveryId === 'd1'
          ? { deliveryId: 'd1', filename: 'report.txt', sizeBytes: deliveries.sizeBytes, filePath: '/workspace/out/report.txt' }
          : undefined,
      },
    }),
  },
}))

import signedFiles from './signed-files'
import {
  MAX_SIGNED_FILE_URL_TTL_MS,
  mintSignedDownloadUrl,
  mintSignedUploadUrl,
  resolveSignedUpload,
  SignedFileUrlError,
} from '@shared/lib/signed-file-urls/signed-file-urls'

const app = new Hono().route('/api/signed-files', signedFiles)

/** The request the URL's holder makes: the path of the absolute URL. */
function redeem(url: string, init: RequestInit = {}) {
  const { pathname, search } = new URL(url)
  return app.request(`${pathname}${search}`, init)
}

function put(url: string, body: BodyInit, headers: Record<string, string> = {}) {
  return redeem(url, { method: 'PUT', body, headers })
}

function writeWorkspaceFile(slug: string, relative: string, content: string) {
  const file = path.join(root, slug, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function grantAgentRole(userId: string, agentSlug: string, role: 'owner' | 'user' | 'viewer') {
  await handle.db.insert(agentAcl).values({ id: `${userId}-${agentSlug}`, userId, agentSlug, role, createdAt: new Date() }).run()
}

async function revokeAgentRole(userId: string, agentSlug: string) {
  await handle.db.delete(agentAcl).where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, agentSlug))).run()
}

/** The token with its payload replaced, the signature kept. */
function withPayload(url: string, change: (payload: Record<string, unknown>) => void): string {
  const [base, token] = url.split('/api/signed-files/')
  const [encoded, signature] = token.split('.')
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  change(payload)
  return `${base}/api/signed-files/${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`
}

let driveFolder: string

beforeEach(async () => {
  declareServerCapabilities(runtimeCapabilities({ os: 'darwin', distribution: 'direct' }))
  vi.stubEnv('AUTH_MODE', 'true')
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signed-files-')))
  driveFolder = path.join(root, '_drive')
  fs.mkdirSync(driveFolder)
  handle = await createTestDatabase()
  audit.logAuditEvent.mockClear()
  await handle.db.insert(user).values([
    { id: 'alice', name: 'Alice', email: 'alice@example.com' },
    { id: 'bob', name: 'Bob', email: 'bob@example.com' },
    { id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'admin' },
  ]).run()
  await handle.db.insert(agents).values([
    { slug: 'agent', name: 'Agent', createdAt: new Date() },
    { slug: 'other', name: 'Other', createdAt: new Date() },
  ]).run()
  await grantAgentRole('alice', 'agent', 'user')
  await grantAgentRole('alice', 'other', 'user')
  await grantAgentRole('bob', 'agent', 'viewer')
  writeWorkspaceFile('agent', 'notes/a.txt', 'alpha file contents')
  writeWorkspaceFile('agent', 'notes/b.txt', 'bravo file contents')
})

afterEach(async () => {
  declareServerCapabilities(null)
  await backgroundSettled()
  await handle.close()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('minting', () => {
  it('returns an absolute URL under the app base URL, expiring after the default five minutes', async () => {
    const now = Date.now()
    const minted = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' }, { now })
    expect(minted.url).toMatch(/^https:\/\/gamut\.test\/api\/signed-files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(minted.expiresAt.getTime()).toBe(now + 5 * 60_000)
    const shorter = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' }, { now, ttlMs: 30_000 })
    expect(shorter.expiresAt.getTime()).toBe(now + 30_000)
  })

  it('refuses a lifetime past the maximum', async () => {
    await expect(mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' }, { ttlMs: MAX_SIGNED_FILE_URL_TTL_MS + 1 }))
      .rejects.toBeInstanceOf(RangeError)
  })

  it('refuses a user without access: no role to download, a viewer to upload, an invalid path', async () => {
    await expect(mintSignedDownloadUrl('bob', { kind: 'workspace-file', agentSlug: 'other', path: 'x.txt' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(mintSignedUploadUrl('bob', { agentSlug: 'agent', filename: 'x.txt' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'missing', path: 'x.txt' }))
      .rejects.toMatchObject({ status: 404 })
    await expect(mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: '../escape' }))
      .rejects.toBeInstanceOf(SignedFileUrlError)
  })
})

describe('downloads', () => {
  it('serves a workspace file as a private, sandboxed attachment', async () => {
    const { url } = await mintSignedDownloadUrl('bob', { kind: 'workspace-file', agentSlug: 'agent', path: '/workspace/notes/a.txt' })
    const response = await redeem(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('alpha file contents')
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="a\.txt"/)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })

  it('answers a Range request with the slice', async () => {
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    const response = await redeem(url, { headers: { Range: 'bytes=6-9' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 6-9/19')
    expect(await response.text()).toBe('file')
    expect((await redeem(url, { headers: { Range: 'bytes=500-' } })).status).toBe(416)
  })

  it('serves a delivered file, and refuses it once it changed since it was delivered', async () => {
    writeWorkspaceFile('agent', 'out/report.txt', 'quarterly numbers')
    deliveries.sizeBytes = 'quarterly numbers'.length
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'delivered-file', agentSlug: 'agent', sessionId: 's1', deliveryId: 'd1' })
    const response = await redeem(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="report\.txt"/)
    expect(await response.text()).toBe('quarterly numbers')

    writeWorkspaceFile('agent', 'out/report.txt', 'quarterly numbers, revised')
    expect((await redeem(url)).status).toBe(409)

    const unknown = await mintSignedDownloadUrl('alice', { kind: 'delivered-file', agentSlug: 'agent', sessionId: 's1', deliveryId: 'nope' })
    expect((await redeem(unknown.url)).status).toBe(404)
  })

  it('serves a drive file the user can see, and stops once they cannot', async () => {
    fs.mkdirSync(path.join(driveFolder, 'docs'))
    fs.writeFileSync(path.join(driveFolder, 'docs', 'plan.md'), '# plan')
    const { id } = await createVolumeDefinition({ type: 'local', config: { path: driveFolder }, name: 'Notes' }, { userId: 'alice', admin: false })
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'drive-file', volumeId: id, path: 'docs/plan.md' })
    const response = await redeem(`${url}?inline=true`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(await response.text()).toBe('# plan')

    await expect(mintSignedDownloadUrl('bob', { kind: 'drive-file', volumeId: id, path: 'docs/plan.md' })).rejects.toMatchObject({ status: 403 })

    // The drive is handed to Bob: Alice can no longer see it.
    await handle.db.insert(volumeAcl).values({ id: 'bob-owns', volumeId: id, userId: 'bob', role: 'owner', createdAt: new Date() }).run()
    await handle.db.delete(volumeAcl).where(and(eq(volumeAcl.volumeId, id), eq(volumeAcl.userId, 'alice'))).run()
    const refused = await redeem(url)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'Forbidden' })
  })

  it('stops working once the user loses the agent or their account', async () => {
    const { url } = await mintSignedDownloadUrl('bob', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    expect((await redeem(url)).status).toBe(200)
    await revokeAgentRole('bob', 'agent')
    expect((await redeem(url)).status).toBe(403)

    const alice = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    await handle.db.update(user).set({ banned: true }).where(eq(user.id, 'alice')).run()
    expect((await redeem(alice.url)).status).toBe(403)
  })

  it('answers 404 for a file that is gone', async () => {
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    fs.rmSync(path.join(root, 'agent', 'notes', 'a.txt'))
    expect((await redeem(url)).status).toBe(404)
  })
})

describe('tokens', () => {
  it('refuses an expired URL', async () => {
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' }, { now: Date.now() - 6 * 60_000 })
    const response = await redeem(url)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Invalid or expired link' })
  })

  it('refuses a tampered signature and a tampered payload, without echoing the token', async () => {
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    const last = url.at(-1) === 'A' ? 'B' : 'A'
    const badSignature = await redeem(`${url.slice(0, -1)}${last}`)
    expect(badSignature.status).toBe(401)

    const otherFile = withPayload(url, (payload) => { (payload.target as { path: string }).path = 'notes/b.txt' })
    const badPayload = await redeem(otherFile)
    expect(badPayload.status).toBe(401)
    const body = await badPayload.text()
    expect(body).toBe(JSON.stringify({ error: 'Invalid or expired link' }))

    const otherUser = withPayload(url, (payload) => { payload.sub = 'bob' })
    expect((await redeem(otherUser)).status).toBe(401)
    expect((await redeem('https://gamut.test/api/signed-files/not-a-token')).status).toBe(401)
  })

  it('binds one file: the URL cannot be pointed at another', async () => {
    const { url } = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    expect(await (await redeem(`${url}?path=notes/b.txt`)).text()).toBe('alpha file contents')
    expect((await redeem(`${url}/../b.txt`)).status).not.toBe(200)
    expect((await redeem(`${url}/notes/b.txt`)).status).toBe(404)
  })

  it('allows only the operation it was minted for', async () => {
    const download = await mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/a.txt' })
    expect((await put(download.url, 'overwrite')).status).toBe(403)
    expect(fs.readFileSync(path.join(root, 'agent', 'notes', 'a.txt'), 'utf8')).toBe('alpha file contents')

    const upload = await mintSignedUploadUrl('alice', { agentSlug: 'agent', filename: 'in.txt' })
    expect((await redeem(upload.url)).status).toBe(403)
    // The refused GET did not spend it.
    expect((await put(upload.url, 'hello')).status).toBe(201)
  })
})

describe('uploads', () => {
  it('writes the body into uploads/ once, and resolves its id for that user and agent only', async () => {
    const { url, uploadId } = await mintSignedUploadUrl('alice', { agentSlug: 'agent', filename: '../My Report.pdf' })
    const response = await put(url, 'pdf bytes')
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ uploadId, filename: 'My_Report.pdf', size: 9 })
    expect(audit.logAuditEvent).toHaveBeenCalledWith({ userId: 'alice', object: 'file', objectId: 'agent/My_Report.pdf', action: 'uploaded' })

    const stored = await resolveSignedUpload('alice', 'agent', uploadId)
    expect(stored).toMatchObject({ filename: 'My_Report.pdf', sizeBytes: 9 })
    expect(stored!.path).toMatch(/^\/workspace\/uploads\/My_Report-\d+\.pdf$/)
    expect(fs.readFileSync(path.join(root, 'agent', stored!.path.slice('/workspace/'.length)), 'utf8')).toBe('pdf bytes')

    expect(await resolveSignedUpload('bob', 'agent', uploadId)).toBeNull()
    expect(await resolveSignedUpload('alice', 'other', uploadId)).toBeNull()
    expect(await resolveSignedUpload('alice', 'agent', 'unknown-upload')).toBeNull()
  })

  it('refuses a second use of the URL', async () => {
    const { url } = await mintSignedUploadUrl('alice', { agentSlug: 'agent', filename: 'once.txt' })
    expect((await put(url, 'first')).status).toBe(201)
    const again = await put(url, 'second')
    expect(again.status).toBe(410)
    expect(fs.readdirSync(path.join(root, 'agent', 'uploads'))).toHaveLength(1)
  })

  it('refuses an oversized body, by its length or as it streams, without spending the URL', async () => {
    const { url, uploadId } = await mintSignedUploadUrl('alice', { agentSlug: 'agent', filename: 'big.bin' })
    expect((await put(url, 'x'.repeat(1025))).status).toBe(413)

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(512))
        controller.close()
      },
    })
    const response = await redeem(url, { method: 'PUT', body: streamed, duplex: 'half' } as RequestInit)
    expect(response.status).toBe(413)
    expect(fs.existsSync(path.join(root, 'agent', 'uploads')) ? fs.readdirSync(path.join(root, 'agent', 'uploads')) : []).toEqual([])

    expect((await put(url, 'x'.repeat(1024))).status).toBe(201)
    expect(await resolveSignedUpload('alice', 'agent', uploadId)).toMatchObject({ sizeBytes: 1024 })
  })

  it('stops working once the user is no more than a viewer', async () => {
    const { url } = await mintSignedUploadUrl('alice', { agentSlug: 'agent', filename: 'late.txt' })
    await handle.db.update(agentAcl).set({ role: 'viewer' }).where(and(eq(agentAcl.userId, 'alice'), eq(agentAcl.agentSlug, 'agent'))).run()
    expect((await put(url, 'too late')).status).toBe(403)
  })
})

describe('without auth mode', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'false')
  })

  it('works for the local user, and only for them', async () => {
    const { url } = await mintSignedDownloadUrl('local', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/b.txt' })
    expect(await (await redeem(url)).text()).toBe('bravo file contents')
    await expect(mintSignedDownloadUrl('alice', { kind: 'workspace-file', agentSlug: 'agent', path: 'notes/b.txt' })).rejects.toMatchObject({ status: 403 })

    const upload = await mintSignedUploadUrl('local', { agentSlug: 'agent', filename: 'local.txt' })
    expect((await put(upload.url, 'local bytes')).status).toBe(201)
    expect(await resolveSignedUpload('local', 'agent', upload.uploadId)).toMatchObject({ sizeBytes: 11 })
  })
})
