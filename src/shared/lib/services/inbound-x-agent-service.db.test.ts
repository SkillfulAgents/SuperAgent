import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTeamBrain } from '../config/settings'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { ApiAgent } from '@shared/lib/types/api'
import type { SessionMetadataMap } from '@shared/lib/types/agent'

let testDb: AppDatabase
let handle: TestDatabase
let agents: ApiAgent[] = []
let metadata: SessionMetadataMap = {}

vi.mock('../config/settings', () => ({ getTeamBrain: vi.fn(async () => null) }))
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: { get: () => ({ sessions: { readMetadata: async () => metadata } }) },
}))
vi.mock('./agent-service', () => ({ listAgentsWithStatus: async () => agents }))

import { buildInboundXAgentDetails, getInboundXAgentDetails } from './inbound-x-agent-service'
import { setPolicy } from './x-agent-policy-service'

const TARGET = 'agent-0'

function agent(index: number): ApiAgent {
  return {
    avatar: { color: 'tonal-blue', shape: 'circle' } as const,
    slug: `agent-${index}`,
    displaySlug: `name-agent-${index}`,
    // Names that do not sort the way the slugs do.
    name: `Agent ${String((index * 7) % 100).padStart(3, '0')} ${index}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'stopped',
    containerPort: null,
  }
}

/**
 * `count` agents, the first of them the target. Every fifth caller's owner has
 * no access to the target (not eligible), the viewer can open every third
 * caller, and the callers' stored policies take every shape in turn.
 */
async function seed(count: number): Promise<void> {
  agents = Array.from({ length: count }, (_, index) => agent(index))
  metadata = count > 1 ? { called: { invokedByAgentSlug: 'agent-1', createdAt: '2026-08-19T10:00:00.000Z' } } : {}
  const createdAt = new Date(0)
  for (const id of ['target-user', 'stranger', 'viewer']) {
    await testDb.insert(schema.user).values({ id, name: id, email: `${id}@example.test` }).run()
  }
  const grant = (userId: string, agentSlug: string, role: 'owner' | 'user' | 'viewer') =>
    testDb.insert(schema.agentAcl).values({ id: `${userId}:${agentSlug}`, userId, agentSlug, role, createdAt }).run()
  for (const [index, { slug, name }] of agents.entries()) {
    await testDb.insert(schema.agents).values({ slug, name, createdAt, runtime: 'local' }).run()
    if (index === 0) {
      await grant('target-user', slug, 'user')
      await grant('viewer', slug, 'viewer')
      continue
    }
    await grant(index % 5 === 4 ? 'stranger' : 'target-user', slug, 'owner')
    if (index % 3 === 0) await grant('viewer', slug, 'viewer')
    const shape = index % 7
    if (shape === 0) await setPolicy(slug, 'invoke', TARGET, 'allow')
    if (shape === 1) await setPolicy(slug, 'invoke', null, 'allow')
    if (shape === 2) await setPolicy(slug, 'invoke', TARGET, 'block')
    if (shape === 3) { await setPolicy(slug, 'invoke', TARGET, 'review'); await setPolicy(slug, 'invoke', null, 'allow') }
    if (shape === 4) { await setPolicy(slug, 'invoke', null, 'block'); await setPolicy(slug, 'invoke', TARGET, 'allow') }
    if (shape === 5) { await setPolicy(slug, 'invoke', 'agent-1', 'block'); await setPolicy(slug, 'read', TARGET, 'block') }
    // shape 6: nothing stored.
  }
}

const VIEWS = [
  { authMode: false },
  { authMode: true, viewerUserId: 'viewer' },
  { authMode: true, viewerUserId: 'admin', viewerCanAccessAll: true },
] as const

/** The answer as it was built before: the same inputs, with `evaluate()` asked once per caller. */
async function onePolicyReadPerCaller(view: (typeof VIEWS)[number]) {
  const aclRows = view.authMode
    ? await testDb.select({ agentSlug: schema.agentAcl.agentSlug, userId: schema.agentAcl.userId, role: schema.agentAcl.role }).from(schema.agentAcl).all()
    : []
  return buildInboundXAgentDetails({ targetSlug: TARGET, metadata, agents, aclRows, ...view })
}

describe('getInboundXAgentDetails', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.mocked(getTeamBrain).mockResolvedValue(null)
    await handle.close()
  })

  it.each([1, 2, 5, 50, 150])('answers as one policy read per caller did, with %i agents', async (count) => {
    await seed(count)
    for (const view of VIEWS) {
      const details = await getInboundXAgentDetails(TARGET, view)
      expect(details).toEqual(await onePolicyReadPerCaller(view))
      if (count >= 50) {
        expect(new Set(details.callers.map((caller) => caller.decision))).toEqual(new Set(['allow', 'review']))
        expect(details.callers.length).toBeLessThan(count - 1)
      }
    }
  })

  it('reads the policies once, however many other agents there are', async () => {
    const statements: Record<string, number[]> = { local: [], member: [], admin: [] }
    for (const count of [2, 5, 50, 150]) {
      await handle.close()
      handle = await createTestDatabase()
      testDb = handle.db
      await seed(count)
      const select = vi.spyOn(testDb, 'select')
      for (const [index, name] of Object.keys(statements).entries()) {
        select.mockClear()
        await getInboundXAgentDetails(TARGET, VIEWS[index])
        statements[name].push(select.mock.calls.length)
      }
      // What it replaces grows with the agents: at least one read for each eligible caller.
      select.mockClear()
      await onePolicyReadPerCaller(VIEWS[0])
      expect(select.mock.calls.length).toBe(count - 1)
      select.mockRestore()
    }
    // The policies; in auth mode the ACL rows before them.
    expect(statements).toEqual({ local: [1, 1, 1, 1], member: [2, 2, 2, 2], admin: [2, 2, 2, 2] })
  })

  it('reads no policy when no other agent is eligible', async () => {
    await seed(1)
    const select = vi.spyOn(testDb, 'select')
    expect((await getInboundXAgentDetails(TARGET, VIEWS[0])).callers).toEqual([])
    expect(select).not.toHaveBeenCalled()
    // Auth mode: the ACL rows only.
    await getInboundXAgentDetails(TARGET, VIEWS[1])
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('applies the Team Brain default to callers with no row, as evaluate() does', async () => {
    await seed(20)
    vi.mocked(getTeamBrain).mockResolvedValue({ agentSlug: TARGET, volumeId: 'team-drive' })
    const time = new Date()
    await testDb.insert(schema.volumeDefinitions).values({
      id: 'team-drive', name: 'Team Brain', type: 'local', config: '{}',
      visibility: 'public', globalAccess: 'read', createdAt: time, updatedAt: time,
    }).run()

    for (const view of VIEWS) {
      const details = await getInboundXAgentDetails(TARGET, view)
      expect(details).toEqual(await onePolicyReadPerCaller(view))
      // agent-6 has no row at all, agent-5 only rows that do not apply; agent-3 keeps its stored review.
      expect(details.callers.find((caller) => caller.slug === 'agent-6')?.decision).toBe('allow')
      expect(details.callers.find((caller) => caller.slug === 'agent-5')?.decision).toBe('allow')
      expect(details.callers.find((caller) => caller.slug === 'agent-3')?.decision).toBe('review')
    }

    const select = vi.spyOn(testDb, 'select')
    vi.mocked(getTeamBrain).mockClear()
    await getInboundXAgentDetails(TARGET, VIEWS[0])
    // The policies and the Team Brain drive, once each.
    expect(select).toHaveBeenCalledTimes(2)
    expect(getTeamBrain).toHaveBeenCalledTimes(1)
  })
})
