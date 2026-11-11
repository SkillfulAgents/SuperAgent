import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { agentSummaries } from '@shared/lib/db/schema'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'
import { GlobalFeed } from '@shared/lib/notifications/global-feed'
import { readAgentSummaries, type AgentSummary } from './agent-summaries'
import { startAgentSummaryWriter } from './agent-summary-writer'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

function summary(sessionCount: number): AgentSummary {
  return {
    container: { status: 'running', port: 8080, healthWarnings: [], stale: false },
    hasActiveSessions: sessionCount > 0,
    hasSessionsAwaitingInput: false,
    awaitingSessionIds: [],
    sessionCount,
    lastActivityAt: null,
    visibleSessionIds: [],
    dashboards: [],
    widgets: [],
  }
}

/** A feed with no AppState behind it: nothing is delivered, which the writer must not need. */
const undeliveredFeed = () => new GlobalFeed(() => null)

const storedRevision = async (slug: string) =>
  (await database.db.select({ revision: agentSummaries.revision }).from(agentSummaries).where(eq(agentSummaries.agentSlug, slug)).get())?.revision

const settled = (summarize: ReturnType<typeof vi.fn>, calls: number) => vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(calls))

describe('agent summary writer', () => {
  it('stores an agent\'s summary after an event this process raises about it, delivered or not', async () => {
    const feed = undeliveredFeed()
    const summarize = vi.fn(async () => summary(3))
    startAgentSummaryWriter({ feed, summarize })

    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })

    await vi.waitFor(async () => expect((await readAgentSummaries(['agent-one'])).get('agent-one')?.sessionCount).toBe(3))
    expect(summarize).toHaveBeenCalledWith('agent-one')
  })

  it('summarizes once for a burst of events, and once more for events raised while it reads', async () => {
    const feed = undeliveredFeed()
    let release!: () => void
    const reading = new Promise<void>((resolve) => { release = resolve })
    const summarize = vi.fn(async () => summary(1))
    summarize.mockImplementationOnce(async () => {
      await reading
      return summary(1)
    })
    startAgentSummaryWriter({ feed, summarize })

    feed.publish({ type: 'agent_status_changed', agentSlug: 'agent-one' })
    feed.publish({ type: 'session_active', agentSlug: 'agent-one' })
    feed.publish({ type: 'session_updated', agentSlug: 'agent-one' })
    await settled(summarize, 1)
    // Raised while the first summary is being read: they are not in it.
    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })
    feed.publish({ type: 'os_notification', agentSlug: 'agent-one' })
    release()

    await settled(summarize, 2)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(summarize).toHaveBeenCalledTimes(2)
  })

  it('does not write a summary equal to the one it stored last', async () => {
    const feed = undeliveredFeed()
    const summarize = vi.fn(async () => summary(2))
    startAgentSummaryWriter({ feed, summarize })

    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })
    await vi.waitFor(async () => expect(await storedRevision('agent-one')).toBeDefined())
    const first = await storedRevision('agent-one')
    feed.publish({ type: 'os_notification', agentSlug: 'agent-one' })
    await settled(summarize, 2)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(await storedRevision('agent-one')).toBe(first)
  })

  it('leaves alone agents whose actor runs elsewhere, events about no agent, and agents that no longer exist', async () => {
    const feed = undeliveredFeed()
    const summarize = vi.fn(async (slug: string) => (slug === 'removed' ? null : summary(1)))
    startAgentSummaryWriter({ feed, summarize, owns: (slug) => slug !== 'elsewhere' })

    feed.publish({ type: 'session_idle', agentSlug: 'elsewhere' })
    feed.publish({ type: 'runtime_readiness_changed' })
    feed.publish({ type: 'session_idle', agentSlug: 'removed' })
    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })

    await vi.waitFor(async () => expect((await readAgentSummaries(['agent-one'])).size).toBe(1))
    expect(summarize.mock.calls.map(([slug]) => slug).sort()).toEqual(['agent-one', 'removed'])
    expect(await readAgentSummaries(['elsewhere', 'removed'])).toEqual(new Map())
  })

  it('stops hearing events once stopped, and a failed read does not stop the next one', async () => {
    const feed = undeliveredFeed()
    const summarize = vi.fn(async () => summary(1))
    summarize.mockRejectedValueOnce(new Error('the agent did not answer'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = startAgentSummaryWriter({ feed, summarize })

    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })
    await settled(summarize, 1)
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })
    await vi.waitFor(async () => expect((await readAgentSummaries(['agent-one'])).size).toBe(1))

    stop()
    feed.publish({ type: 'session_idle', agentSlug: 'agent-one' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(summarize).toHaveBeenCalledTimes(2)
    errors.mockRestore()
  })
})
