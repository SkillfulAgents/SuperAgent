/**
 * IsAgent() against a real database: in auth mode the proxy token and the
 * agent's owner are read in one statement, and the agent and owner it finds
 * are the ones `validateProxyToken` then `getAgentOwnerUserId` found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

let authMode = true
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode }))
vi.mock('@shared/lib/auth/index', () => ({ getAuth: () => ({ api: {} }) }))

import { getRequestUserId } from '@shared/lib/platform-attribution/request-context'
import { getAgentOwnerUserId } from '@shared/lib/services/agent-owner'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { IsAgent } from './auth'

/** Every statement drizzle prepares goes through its session, on both drivers; it has no public hook. */
function statements() {
  const session = (testDb as unknown as { session: { prepareQuery(...args: unknown[]): unknown } }).session
  return vi.spyOn(session, 'prepareQuery')
}

async function call(authorization?: string) {
  const app = new Hono<{ Variables: { agentSlug: string } }>()
  app.use('*', IsAgent())
  app.get('/x', (c) => c.json({ agentSlug: c.get('agentSlug'), user: getRequestUserId() ?? null }))
  const response = await app.request('http://localhost/x', { headers: authorization === undefined ? {} : { Authorization: authorization } })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  authMode = true
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(schema.user).values(['early', 'late', 'member', 'other'].map(id => ({ id, name: id, email: `${id}@example.test` }))).run()
  await testDb.insert(schema.proxyTokens).values([
    { id: 't1', agentSlug: 'agent-a', token: 'synth_a', createdAt: new Date(0) },
    { id: 't2', agentSlug: 'agent-b', token: 'synth_b', createdAt: new Date(0) },
    { id: 't3', agentSlug: 'agent-c', token: 'synth_c', createdAt: new Date(0) },
  ]).run()
  await testDb.insert(schema.agentAcl).values([
    // The later owner is inserted first, and a non-owner is older than both: neither may be picked.
    { id: 'acl-1', userId: 'late', agentSlug: 'agent-a', role: 'owner', createdAt: new Date(3000) },
    { id: 'acl-2', userId: 'member', agentSlug: 'agent-a', role: 'user', createdAt: new Date(1000) },
    { id: 'acl-3', userId: 'early', agentSlug: 'agent-a', role: 'owner', createdAt: new Date(2000) },
    { id: 'acl-4', userId: 'other', agentSlug: 'agent-b', role: 'owner', createdAt: new Date(500) },
    { id: 'acl-5', userId: 'member', agentSlug: 'agent-c', role: 'viewer', createdAt: new Date(500) },
  ]).run()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('IsAgent() in auth mode', () => {
  it('reads the token and the owner in one statement', async () => {
    const prepared = statements()

    expect(await call('Bearer synth_a')).toEqual({ status: 200, body: { agentSlug: 'agent-a', user: 'early' } })
    expect(prepared).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['synth_a', 'agent-a', 'early'],
    ['synth_b', 'agent-b', 'other'],
    ['synth_c', 'agent-c', null],
  ])('gives %s the agent and owner the two lookups gave', async (token, agentSlug, owner) => {
    expect(await validateProxyToken(token)).toBe(agentSlug)
    expect(await getAgentOwnerUserId(agentSlug)).toBe(owner)
    expect(await call(`Bearer ${token}`)).toEqual({ status: 200, body: { agentSlug, user: owner } })
  })

  it('lets an agent with no owner through, with no user scope', async () => {
    await testDb.delete(schema.agentAcl).run()

    expect(await call('Bearer synth_a')).toEqual({ status: 200, body: { agentSlug: 'agent-a', user: null } })
  })

  it('refuses an unknown token in that one statement, and no token without any', async () => {
    const prepared = statements()

    expect((await call('Bearer synth_nope')).status).toBe(401)
    // A user id is not a token, and neither is an agent slug.
    expect((await call('Bearer early')).status).toBe(401)
    expect((await call('Bearer agent-a')).status).toBe(401)
    expect(prepared).toHaveBeenCalledTimes(3)

    prepared.mockClear()
    expect((await call()).status).toBe(401)
    expect((await call('')).status).toBe(401)
    expect(prepared).not.toHaveBeenCalled()
  })

  it('refuses a token once it is revoked', async () => {
    await testDb.delete(schema.proxyTokens).run()

    expect((await call('Bearer synth_a')).status).toBe(401)
  })
})

describe('IsAgent() without auth mode', () => {
  it('reads the token alone, and opens no user scope whatever agent_acl holds', async () => {
    authMode = false
    const prepared = statements()

    expect(await call('Bearer synth_a')).toEqual({ status: 200, body: { agentSlug: 'agent-a', user: null } })
    expect((await call('Bearer synth_nope')).status).toBe(401)
    expect(prepared).toHaveBeenCalledTimes(2)
  })
})
