import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { GlobalFeed } from '../notifications/global-feed'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))

import {
  AGENT_SUMMARY_EVENT,
  readAgentSummaries,
  startAgentSummaryPublisher,
  startAgentSummaryWriter,
  type AgentSummary,
} from './agent-summaries'

const summary = (status: string, sessionCount: number): AgentSummary => ({
  container: { status: status as AgentSummary['container']['status'], port: null, healthWarnings: [], stale: false },
  hasActiveSessions: status === 'running',
  hasSessionsAwaitingInput: false,
  sessionCount,
  lastActivityAt: '2026-10-27T12:00:00.000Z',
  visibleSessionIds: [],
  dashboards: [],
  widgets: [],
})

describe('agent summaries', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })
  afterEach(async () => {
    await handle.close()
  })

  it('publishes one summary for a burst of events about an agent, and none for its own events', async () => {
    const feed = new GlobalFeed()
    const summarize = vi.fn(async () => summary('running', 3))
    const published: unknown[] = []
    feed.subscribe((event) => {
      if (event.type === AGENT_SUMMARY_EVENT) published.push(event)
    })
    const stop = startAgentSummaryPublisher(feed, summarize)

    feed.publish({ type: 'agent_status_changed', agentSlug: 'sales-agent', status: 'running' })
    feed.publish({ type: 'session_active', agentSlug: 'sales-agent', sessionId: 's1' })
    feed.publish({ type: 'session_active', agentSlug: 'sales-agent', sessionId: 's2' })
    await vi.waitFor(() => expect(published).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(published).toEqual([{ type: AGENT_SUMMARY_EVENT, agentSlug: 'sales-agent', summary: summary('running', 3) }])
    stop()
  })

  it('stores the latest summary per agent, and reads them back without the actors', async () => {
    const feed = new GlobalFeed()
    const stop = startAgentSummaryWriter(feed)

    feed.publish({ type: AGENT_SUMMARY_EVENT, agentSlug: 'sales-agent', summary: summary('running', 3) })
    feed.publish({ type: AGENT_SUMMARY_EVENT, agentSlug: 'support-agent', summary: summary('stopped', 1) })
    feed.publish({ type: AGENT_SUMMARY_EVENT, agentSlug: 'sales-agent', summary: summary('stopped', 4) })

    await vi.waitFor(async () => {
      const rows = await readAgentSummaries(['sales-agent', 'support-agent', 'unknown-agent'])
      expect(Object.fromEntries(rows)).toEqual({ 'sales-agent': summary('stopped', 4), 'support-agent': summary('stopped', 1) })
    })
    stop()
  })
})
