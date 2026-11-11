import { describe, expect, it, vi } from 'vitest'
import { agentSummaries } from '@shared/lib/db/schema'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import {
  dropAgentSummary,
  nextSummaryRevision,
  readAgentSummaries,
  storeAgentSummary,
  type AgentSummary,
} from './agent-summaries'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

function summary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    container: { status: 'stopped', port: null, healthWarnings: [], stale: false },
    hasActiveSessions: false,
    hasSessionsAwaitingInput: false,
    awaitingSessionIds: [],
    sessionCount: 0,
    lastActivityAt: null,
    visibleSessionIds: [],
    dashboards: [],
    widgets: [],
    ...overrides,
  }
}

describe('agent summaries', () => {
  it('reads back what was stored, for the agents asked about only', async () => {
    await storeAgentSummary('agent-one', summary({ sessionCount: 3, visibleSessionIds: ['s1'] }), 10)
    await storeAgentSummary('agent-two', summary({ sessionCount: 7 }), 10)

    const read = await readAgentSummaries(['agent-one', 'agent-three'])

    expect([...read.keys()]).toEqual(['agent-one'])
    expect(read.get('agent-one')).toMatchObject({ sessionCount: 3, visibleSessionIds: ['s1'] })
  })

  it('keeps the summary read later when the one read earlier is written last', async () => {
    expect(await storeAgentSummary('agent-one', summary({ sessionCount: 2 }), 200)).toBe(true)
    // Read before the stored one, written after it: a slow writer.
    expect(await storeAgentSummary('agent-one', summary({ sessionCount: 1 }), 100)).toBe(false)
    expect(await storeAgentSummary('agent-one', summary({ sessionCount: 9 }), 200)).toBe(false)

    expect((await readAgentSummaries(['agent-one'])).get('agent-one')?.sessionCount).toBe(2)

    expect(await storeAgentSummary('agent-one', summary({ sessionCount: 3 }), 201)).toBe(true)
    expect((await readAgentSummaries(['agent-one'])).get('agent-one')?.sessionCount).toBe(3)
  })

  it('takes revisions that never repeat and stay ahead of an earlier process', () => {
    const first = nextSummaryRevision(1_000)
    // The same millisecond, and a clock that stepped back.
    const second = nextSummaryRevision(1_000)
    const third = nextSummaryRevision(900)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
    // A process started later takes its first revision from the clock, past all of these.
    expect(nextSummaryRevision(5_000)).toBe(5_000)
  })

  it('forgets a removed agent, so an agent made again starts without a summary', async () => {
    await storeAgentSummary('agent-one', summary({ sessionCount: 4 }), 500)

    await dropAgentSummary('agent-one')

    expect(await readAgentSummaries(['agent-one'])).toEqual(new Map())
    // Its first summary is stored whatever revision the removed one had.
    expect(await storeAgentSummary('agent-one', summary({ sessionCount: 0 }), 1)).toBe(true)
  })

  it('counts a stored value it cannot read as missing', async () => {
    await database.db.insert(agentSummaries).values([
      { agentSlug: 'wrong-shape', summary: '{"sessionCount":"many"}', revision: 1, updatedAt: new Date() },
      { agentSlug: 'not-json', summary: '{"container":', revision: 1, updatedAt: new Date() },
    ]).run()
    await storeAgentSummary('fine', summary(), 1)

    expect([...(await readAgentSummaries(['wrong-shape', 'not-json', 'fine'])).keys()]).toEqual(['fine'])
  })

  it('refuses to store a summary that does not match the schema', async () => {
    const broken = { ...summary(), sessionCount: -1 }
    await expect(storeAgentSummary('agent-one', broken, 1)).rejects.toThrow()
    expect(await readAgentSummaries(['agent-one'])).toEqual(new Map())
  })
})
