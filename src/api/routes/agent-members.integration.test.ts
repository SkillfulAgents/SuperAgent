import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { MAX_AGENT_MEMBERS_BATCH_SIZE, type CollaborationEvent } from '@shared/lib/agent-members-schema'
import { persistedSettingsSchema } from '@shared/lib/config/settings-schema'

let directory: string
let db: typeof import('@shared/lib/db')
let authModule: typeof import('@shared/lib/auth')
let service: typeof import('@shared/lib/services/agent-members-service')
let events: typeof import('@shared/lib/services/collaboration-events')
let app: Hono
const agentSlug = '0123456789'
const secondAgent = '9876543210'
const privateAgent = 'private-agent'
const emptyAgent = 'empty-agent'
const people: Record<string, { id: string; token: string }> = {}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-members-'))
  for (const slug of [agentSlug, secondAgent, privateAgent, emptyAgent]) {
    fs.mkdirSync(path.join(directory, 'agents', slug), { recursive: true })
  }
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(persistedSettingsSchema.parse({ auth: { signupMode: 'open', requireAdminApproval: false } })))
  vi.stubEnv('SUPERAGENT_DATA_DIR', directory)
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('BETTER_AUTH_SECRET', 'member-test-secret-0123456789abcdef0123456789abcdef')
  db = await import('@shared/lib/db')
  authModule = await import('@shared/lib/auth')
  service = await import('@shared/lib/services/agent-members-service')
  events = await import('@shared/lib/services/collaboration-events')
  const { Authenticated, ResolveAgent, AgentAdmin } = await import('../middleware/auth')
  const { default: members, agentMembersBatch } = await import('./agent-members')
  app = new Hono()
  app.use('/api/agents/*', Authenticated())
  app.route('/api/agents/members/batch', agentMembersBatch)
  app.use('/api/agents/:id/*', ResolveAgent())
  app.route('/api/agents/:id/members', members)
  app.get('/api/agents/:id/access', AgentAdmin(), (c) => c.json({ management: true }))
  for (const name of ['admin', 'owner', 'user', 'viewer', 'outsider']) {
    const result = await authModule.getAuth().api.signUpEmail({ body: { name, email: `${name}@example.test`, password: 'MemberTesting123!' } })
    people[name] = { id: result.user.id, token: result.token! }
  }
  const { agentAcl } = await import('@shared/lib/db/schema')
  for (const [index, role] of ['owner', 'user', 'viewer'].entries()) {
    db.db.insert(agentAcl).values({ id: randomUUID(), userId: people[role].id, agentSlug, role: role as 'owner' | 'user' | 'viewer', createdAt: new Date(index * 1000) }).run()
  }
  db.db.insert(agentAcl).values([
    { id: randomUUID(), userId: people.viewer.id, agentSlug: secondAgent, role: 'owner', createdAt: new Date(0) },
    { id: randomUUID(), userId: people.owner.id, agentSlug: secondAgent, role: 'viewer', createdAt: new Date(1000) },
    { id: randomUUID(), userId: people.outsider.id, agentSlug: privateAgent, role: 'owner', createdAt: new Date(0) },
  ]).run()

})
afterAll(() => {
  authModule.resetAuth()
  db.sqlite.close()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})
function get(name: string | null, resource = 'members', slug = agentSlug) {
  return app.request(`/api/agents/${slug}/${resource}`, name ? { headers: { authorization: `Bearer ${people[name].token}` } } : {})
}


function batch(name: string | null, agentSlugs: string[]) {
  return app.request('/api/agents/members/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(name ? { authorization: `Bearer ${people[name].token}` } : {}) },
    body: JSON.stringify({ agentSlugs }),
  })
}

describe('authorized agent roster', () => {
  it('returns the same minimal, ordered roster for owners, users, viewers, and admins', async () => {
    const override = '/api/profile/images/00000000-0000-4000-8000-000000000001.png'
    db.sqlite.prepare('UPDATE user SET image = ?, avatar_override = ? WHERE id = ?').run('https://example.test/provider.png', override, people.viewer.id)
    for (const name of ['owner', 'user', 'viewer', 'admin']) {
      const response = await get(name, 'members', `launch-${agentSlug}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(['owner', 'user', 'viewer'].map((role) => ({
        id: people[role].id, name: role, email: `${role}@example.test`, role, image: role === 'viewer' ? override : null,
      })))
    }
  })

  it('rejects unauthenticated, unrelated, and missing-agent reads without relaxing management permissions', async () => {
    expect((await get(null)).status).toBe(401)
    expect((await get('outsider')).status).toBe(403)
    expect((await get('viewer', 'members', 'does-not-exist')).status).toBe(404)
    for (const name of ['user', 'viewer', 'outsider']) expect((await get(name, 'access')).status).toBe(403)
    for (const name of ['owner', 'admin']) expect((await get(name, 'access')).status).toBe(200)
  })

  it('batches authorized rosters and isolates forbidden or missing agents', async () => {
    for (const name of ['owner', 'viewer', 'user', 'admin']) {
      const response = await batch(name, [agentSlug, `launch-${secondAgent}`, privateAgent, 'missing', agentSlug])
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(Object.keys(result)).toHaveLength(4)
      expect(result[agentSlug]).toEqual({ status: 200, members: await (await get(name)).json() })
      expect(result[`launch-${secondAgent}`]).toEqual(name === 'user'
        ? { status: 403 }
        : { status: 200, members: await (await get(name, 'members', secondAgent)).json() })
      expect(result[privateAgent]).toEqual(name === 'admin'
        ? { status: 200, members: await (await get(name, 'members', privateAgent)).json() }
        : { status: 403 })
      expect(result.missing).toEqual({ status: 404 })
    }
    expect(await (await batch('outsider', [agentSlug, secondAgent])).json()).toEqual({
      [agentSlug]: { status: 403 }, [secondAgent]: { status: 403 },
    })
    expect(await (await batch('admin', [emptyAgent])).json()).toEqual({ [emptyAgent]: { status: 200, members: [] } })
  })

  it('loads multiple rosters in two data queries with distinct per-agent roles and stable order', () => {
    const prepare = vi.spyOn(Database.prototype, 'prepare')
    try {
      const result = service.listAgentMembersByAgent([agentSlug, secondAgent, emptyAgent, agentSlug])
      expect(prepare).toHaveBeenCalledTimes(2) // One membership query and one shared user lookup.
      expect(result[agentSlug].map(member => member.id)).toEqual([people.owner.id, people.user.id, people.viewer.id])
      expect(result[secondAgent].map(member => [member.id, member.role])).toEqual([
        [people.viewer.id, 'owner'], [people.owner.id, 'viewer'],
      ])
      expect(result[emptyAgent]).toEqual([])
      expect(result[secondAgent][0].image).toBe(result[agentSlug][2].image)
      prepare.mockClear()
      expect(service.listAgentMembersByAgent([])).toEqual({})
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      prepare.mockRestore()
    }
  })

  it('requires a session, limits batch size, and disables batch reads outside auth mode', async () => {
    expect((await batch(null, [agentSlug])).status).toBe(401)
    expect((await batch('owner', [])).status).toBe(400)
    expect((await batch('owner', Array(MAX_AGENT_MEMBERS_BATCH_SIZE + 1).fill(agentSlug))).status).toBe(400)
    expect((await batch('owner', ['a'.repeat(40_000)])).status).toBe(413)
    vi.stubEnv('AUTH_MODE', 'false')
    try {
      expect((await batch(null, [agentSlug])).status).toBe(404)
    } finally {
      vi.stubEnv('AUTH_MODE', 'true')
    }
  })

  it('sends a membership change when a removed deployment admin retains access', async () => {
    const { agentAcl } = await import('@shared/lib/db/schema')
    db.db.insert(agentAcl).values({ id: randomUUID(), userId: people.admin.id, agentSlug, role: 'viewer', createdAt: new Date() }).run()
    const received: CollaborationEvent[] = []
    const stop = events.subscribeCollaborationEvents(people.admin.id, (event) => { received.push(event) })
    try {
      db.sqlite.prepare('DELETE FROM agent_acl WHERE agent_slug = ? AND user_id = ?').run(agentSlug, people.admin.id)
      service.notifyAgentMembersChanged(agentSlug, people.admin.id)
      expect(received).toEqual([{ type: 'agent_members_changed', agentSlug }])
      expect((await get('admin')).status).toBe(200)
      expect((await get('admin', 'access')).status).toBe(200)
      expect(service.listAgentMembers(agentSlug).some((member) => member.id === people.admin.id)).toBe(false)
    } finally {
      stop()
      db.sqlite.prepare('DELETE FROM agent_acl WHERE agent_slug = ? AND user_id = ?').run(agentSlug, people.admin.id)
    }
  })

  it('scopes profile and membership hints and delivers revocation after removing access', async () => {
    const received = Object.fromEntries(Object.keys(people).map((name) => [name, [] as CollaborationEvent[]]))
    const stops = Object.keys(people).map((name) => events.subscribeCollaborationEvents(people[name].id, (event) => { received[name].push(event) }))
    try {
      service.notifyUserProfileChanged(people.viewer.id)
      for (const name of ['owner', 'user', 'viewer']) expect(received[name]).toEqual([{ type: 'user_profile_changed', userId: people.viewer.id }])
      expect(received.outsider).toEqual([])
      expect(received.admin).toEqual([])
      // A real Better Auth profile update uses the same audience.
      await (await authModule.getAuth().$context).internalAdapter.updateUser(people.viewer.id, { name: 'Updated Viewer' })
      expect(received.owner).toHaveLength(2)
      db.sqlite.prepare('DELETE FROM agent_acl WHERE agent_slug = ? AND user_id = ?').run(agentSlug, people.viewer.id)
      service.notifyAgentMembersChanged(agentSlug, people.viewer.id)
      expect(received.owner.at(-1)).toEqual({ type: 'agent_members_changed', agentSlug })
      expect(received.user.at(-1)).toEqual({ type: 'agent_members_changed', agentSlug })
      expect(received.viewer.at(-1)).toEqual({ type: 'agent_access_revoked', agentSlug })
      expect((await get('viewer')).status).toBe(403)
      expect((await (await batch('viewer', [agentSlug, secondAgent])).json())[agentSlug]).toEqual({ status: 403 })
      db.sqlite.prepare('DELETE FROM agent_acl WHERE agent_slug = ? AND user_id = ?').run(secondAgent, people.viewer.id)
      service.notifyUserProfileChanged(people.owner.id)
      expect(received.viewer).toHaveLength(3)
      expect(received.outsider).toEqual([])
      expect(received.admin).toEqual([])
    } finally {
      stops.forEach((stop) => stop())
    }
  })
})
