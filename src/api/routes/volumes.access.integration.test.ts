/**
 * /api/volumes with the real proxy tokens, IsAgent() and mount lookup: which
 * agent a volume id serves, and how many statements a WebDAV request costs.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agentAcl, agents, proxyTokens, user } from '@shared/lib/db/schema'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

let authMode = true
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode }))
vi.mock('@shared/lib/auth/index', () => ({ getAuth: () => ({ api: {} }) }))

import { addMount, attachMount, getMounts, removeMount, resolveVolume } from '@shared/lib/services/mount-service'
import { updateVolumeDefinition } from '@shared/lib/services/volume-service'
import volumes from './volumes'

const viewer = { userId: null, admin: true }
// `agent` is a prefix of `agent-a`: a global id for one must not read as a global id for the other.
const AGENTS = ['agent-a', 'agent-b', 'agent'] as const
type Agent = typeof AGENTS[number]

/** Every statement drizzle prepares goes through its session, on both drivers; it has no public hook. */
function statements() {
  const session = (handle.db as unknown as { session: { prepareQuery(...args: unknown[]): unknown } }).session
  return vi.spyOn(session, 'prepareQuery')
}

function request(agent: Agent, url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const app = new Hono()
  app.route('/api/volumes', volumes)
  return app.request(`http://localhost/api/volumes/${url}`, { ...init, headers: { Authorization: `Bearer synth_${agent}`, ...init.headers } })
}

const propfind = async (agent: Agent, id: string) =>
  (await request(agent, `${encodeURIComponent(id)}/`, { method: 'PROPFIND', headers: { Depth: '1' } })).status

describe('/api/volumes: whose volume an id is', () => {
  let tmpDir: string
  let ownA: string
  let ownB: string
  let definitionA: string
  let definitionB: string
  let globalVolumeId: string

  function folder(name: string): string {
    const dir = path.join(tmpDir, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, `${name}.txt`), name)
    return dir
  }

  beforeEach(async () => {
    authMode = true
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volumes-access-')))
    process.env.SUPERAGENT_DATA_DIR = tmpDir
    handle = await createTestDatabase()
    await handle.db.insert(agents).values(AGENTS.map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
    await handle.db.insert(proxyTokens).values(AGENTS.map(slug => ({ id: slug, agentSlug: slug, token: `synth_${slug}`, createdAt: new Date() }))).run()
    await handle.db.insert(user).values({ id: 'owner', name: 'owner', email: 'owner@example.test' }).run()
    await handle.db.insert(agentAcl).values(AGENTS.map(slug => ({ id: slug, userId: 'owner', agentSlug: slug, role: 'owner' as const, createdAt: new Date() }))).run()
    const a = await addMount('agent-a', 'local', { path: folder('a') }, viewer)
    const b = await addMount('agent-b', 'local', { path: folder('b') }, viewer)
    ;[ownA, ownB, definitionA, definitionB] = [a.id, b.id, a.volumeId, b.volumeId]
    // A drive no agent has attached, given to every agent read-only.
    const shared = await addMount('agent-b', 'local', { path: folder('shared') }, viewer)
    globalVolumeId = shared.volumeId
    expect(await removeMount('agent-b', shared.id, viewer)).toBe(true)
    await updateVolumeDefinition(globalVolumeId, { global: 'read' }, viewer)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await handle.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  })

  it('serves an agent its own attachment and its own global id', async () => {
    expect(await propfind('agent-a', ownA)).toBe(207)
    expect(await propfind('agent-b', ownB)).toBe(207)
    for (const agent of AGENTS) expect(await propfind(agent, `global-${agent}-${globalVolumeId}`), agent).toBe(207)
    const listing = await request('agent', `global-agent-${globalVolumeId}/`, { method: 'PROPFIND', headers: { Depth: '1' } })
    expect(await listing.text()).toContain('shared.txt')
  })

  it('refuses another agent’s attachment id, for reads and writes alike', async () => {
    expect(await propfind('agent-a', ownB)).toBe(403)
    expect(await propfind('agent-b', ownA)).toBe(403)
    expect(await propfind('agent', ownA)).toBe(403)
    expect((await request('agent-a', `${ownB}/b.txt`)).status).toBe(403)
    expect((await request('agent-a', `${ownB}/new.txt`, { method: 'PUT', body: 'x' })).status).toBe(403)
    expect((await request('agent-a', `${ownB}/b.txt`, { method: 'DELETE' })).status).toBe(403)
    expect(fs.readdirSync(path.join(tmpDir, 'b'))).toEqual(['b.txt'])
  })

  it('refuses a global id made for another agent', async () => {
    expect(await propfind('agent-a', `global-agent-b-${globalVolumeId}`)).toBe(403)
    expect(await propfind('agent-b', `global-agent-a-${globalVolumeId}`)).toBe(403)
    // `global-agent-` is a prefix of agent-a's id, which for `agent` would name the drive `a-<id>`.
    expect(await propfind('agent', `global-agent-a-${globalVolumeId}`)).toBe(403)
    expect(await propfind('agent-a', `global-agent-${globalVolumeId}`)).toBe(403)
  })

  it('refuses a definition id: only an attachment or a global id is a grant', async () => {
    expect(await propfind('agent-a', definitionA)).toBe(403)
    expect(await propfind('agent-a', definitionB)).toBe(403)
    expect(await propfind('agent-a', globalVolumeId)).toBe(403)
    // Wrapping a drive that is not global in a global id grants nothing either.
    expect(await propfind('agent-a', `global-agent-a-${definitionB}`)).toBe(403)
    expect(await propfind('agent-a', `global-agent-a-${ownB}`)).toBe(403)
  })

  it.each([
    'nope', 'global-', 'global-agent-a', 'global-agent-a-', 'global-agent-a-nope', 'global--', '%', '_',
    `' OR '1'='1`, `x' OR agent_slug = 'agent-b`, ' ',
  ])('refuses the malformed id %j', async (id) => {
    expect(await propfind('agent-a', id)).toBe(403)
    expect(await resolveVolume('agent-a', id)).toBeNull()
  })

  it('refuses every id without a valid token', async () => {
    const init = { method: 'PROPFIND', headers: { Depth: '0', Authorization: 'Bearer synth_nope' } }
    expect((await request('agent-a', `${ownA}/`, init)).status).toBe(401)
    expect((await request('agent-a', `global-agent-a-${globalVolumeId}/`, init)).status).toBe(401)
    expect((await request('agent-a', `${ownA}/`, { method: 'PROPFIND', headers: { Authorization: '' } })).status).toBe(401)
  })

  it('keeps a global drive at its level, and stops serving it once it is no longer global', async () => {
    const id = `global-agent-a-${globalVolumeId}`
    expect((await request('agent-a', `${id}/new.txt`, { method: 'PUT', body: 'x' })).status).toBe(403)
    await updateVolumeDefinition(globalVolumeId, { global: 'write' }, viewer)
    expect((await request('agent-a', `${id}/new.txt`, { method: 'PUT', body: 'x' })).status).toBe(201)
    await updateVolumeDefinition(globalVolumeId, { global: null }, viewer)
    expect(await propfind('agent-a', id)).toBe(403)
  })

  it('serves an attached global drive under its attachment id only, at the attachment’s level', async () => {
    const attached = await attachMount('agent-a', globalVolumeId, viewer, { readOnly: true })
    await updateVolumeDefinition(globalVolumeId, { global: 'write' }, viewer)

    expect(await propfind('agent-a', `global-agent-a-${globalVolumeId}`)).toBe(403)
    expect(await propfind('agent-a', attached.id)).toBe(207)
    expect((await request('agent-a', `${attached.id}/new.txt`, { method: 'PUT', body: 'x' })).status).toBe(403)
    expect(await propfind('agent-b', attached.id)).toBe(403)
    expect((await request('agent-b', `global-agent-b-${globalVolumeId}/new.txt`, { method: 'PUT', body: 'x' })).status).toBe(201)
  })

  it('resolves every id to the mount the full listing gives, and nothing else', async () => {
    for (const agent of AGENTS) {
      const mounts = await getMounts(agent)
      for (const other of AGENTS) {
        for (const mount of await getMounts(other)) {
          const resolved = await resolveVolume(agent, mount.id)
          const listed = mounts.find(m => m.id === mount.id)
          expect(resolved && { name: resolved.ops.name, readOnly: resolved.readOnly }, `${agent} on ${mount.id}`)
            .toEqual(listed ? { name: listed.name, readOnly: listed.readOnly } : null)
        }
      }
    }
  })

  describe('statements per request', () => {
    it.each([['auth mode', true], ['local mode', false]])('reads an attachment in two: the token, then the one mount (%s)', async (_, mode) => {
      authMode = mode
      const prepared = statements()

      expect(await propfind('agent-a', ownA)).toBe(207)
      expect(prepared).toHaveBeenCalledTimes(2)

      prepared.mockClear()
      expect((await request('agent-a', `${ownA}/a.txt`)).status).toBe(200)
      expect(prepared).toHaveBeenCalledTimes(2)
    })

    it('refuses another agent’s attachment in the same two', async () => {
      const prepared = statements()

      expect(await propfind('agent-a', ownB)).toBe(403)
      expect(prepared).toHaveBeenCalledTimes(2)
    })

    it('reads a global drive in three: the token, then the agent’s mounts as one pair', async () => {
      const prepared = statements()

      expect(await propfind('agent-a', `global-agent-a-${globalVolumeId}`)).toBe(207)
      expect(prepared).toHaveBeenCalledTimes(3)
    })

    it('does not grow with the number of drives the agent has', async () => {
      for (let n = 0; n < 5; n++) await addMount('agent-a', 'local', { path: folder(`more-${n}`) }, viewer)
      const prepared = statements()

      expect(await propfind('agent-a', ownA)).toBe(207)
      expect(prepared).toHaveBeenCalledTimes(2)
    })
  })
})
