/**
 * What an agent list shows of each agent, kept as a row per agent so a
 * listing reads one table and touches no actor.
 *
 * - Where the actors run, `startAgentSummaryPublisher` hears every feed event
 *   about an agent and publishes one `agent_summary` event with the agent's
 *   summary as of then (coalesced: a burst of events costs one `live()`).
 * - Where the database is, `startAgentSummaryWriter` stores each summary.
 * - `listAgentsWithStatus` reads the rows once a deployment turns on
 *   `useStoredAgentSummaries`; otherwise it asks each actor, as before.
 *
 * In one process the two halves meet on the global feed; across a wire the
 * feed transport carries the event from the actor's side to the host's.
 */
import { inArray } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { agentSummaries } from '@shared/lib/db/schema'
import { background } from '@shared/lib/background'
import type { GlobalFeed } from '@shared/lib/notifications/global-feed'
import type { AgentLiveSummary, AgentSlug } from '@shared/lib/agent-actor/types'

export const AGENT_SUMMARY_EVENT = 'agent_summary'

export interface AgentSummary {
  container: Pick<AgentLiveSummary['container'], 'status' | 'port' | 'healthWarnings' | 'stale'>
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
  sessionCount: number
  lastActivityAt: string | null
}

export function agentSummaryOf(
  live: AgentLiveSummary,
  sessions: { sessionCount: number; lastActivityAt: Date | null },
): AgentSummary {
  const { status, port, healthWarnings, stale } = live.container
  return {
    container: { status, port, healthWarnings, stale },
    hasActiveSessions: live.activeSessionIds.length > 0,
    hasSessionsAwaitingInput: live.awaitingSessionIds.length > 0 || live.pendingReviews.length > 0,
    sessionCount: sessions.sessionCount,
    lastActivityAt: sessions.lastActivityAt?.toISOString() ?? null,
  }
}

/** Publish an agent's summary after any event about it; `summarize` reads the agent's actor. */
export function startAgentSummaryPublisher(feed: GlobalFeed, summarize: (slug: AgentSlug) => Promise<AgentSummary>): () => void {
  const running = new Set<AgentSlug>()
  const again = new Set<AgentSlug>()
  const publish = async (slug: AgentSlug): Promise<void> => {
    running.add(slug)
    try {
      do {
        // Lets the rest of a burst land first: it is all in one summary.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        again.delete(slug)
        feed.publish({ type: AGENT_SUMMARY_EVENT, agentSlug: slug, summary: await summarize(slug) })
      } while (again.has(slug))
    } catch (error) {
      console.error(`[AgentSummaries] Could not summarize ${slug}:`, error)
    } finally {
      running.delete(slug)
    }
  }
  return feed.subscribe((event) => {
    const slug = event.agentSlug
    if (!slug || event.type === AGENT_SUMMARY_EVENT) return
    if (running.has(slug)) {
      again.add(slug)
      return
    }
    background(publish(slug), { name: 'agent-summaries.publish' })
  })
}

/** Store every published summary. */
export function startAgentSummaryWriter(feed: GlobalFeed): () => void {
  return feed.subscribe((event) => {
    if (event.type !== AGENT_SUMMARY_EVENT || !event.agentSlug) return
    const row = { summary: JSON.stringify(event.summary), updatedAt: new Date() }
    background(
      db.insert(agentSummaries).values({ agentSlug: event.agentSlug, ...row }).onConflictDoUpdate({ target: agentSummaries.agentSlug, set: row }).then(() => undefined),
      { name: 'agent-summaries.write' },
    )
  })
}

export async function readAgentSummaries(slugs: readonly AgentSlug[]): Promise<Map<AgentSlug, AgentSummary>> {
  if (slugs.length === 0) return new Map()
  const rows = await db.select().from(agentSummaries).where(inArray(agentSummaries.agentSlug, [...slugs])).all()
  return new Map(rows.map((row) => [row.agentSlug, JSON.parse(row.summary) as AgentSummary]))
}

let stored = false

/** Serve agent lists from the stored summaries instead of each actor. */
export function useStoredAgentSummaries(on: boolean): void {
  stored = on
}

export function storedAgentSummariesInUse(): boolean {
  return stored
}

/** An agent no summary was published for yet: nothing has happened to it since the table began. */
export const NO_AGENT_SUMMARY: AgentSummary = {
  container: { status: 'stopped', port: null, healthWarnings: [], stale: false },
  hasActiveSessions: false,
  hasSessionsAwaitingInput: false,
  sessionCount: 0,
  lastActivityAt: null,
}
