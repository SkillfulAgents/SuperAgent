/**
 * What pages that show agents need of each one (agent lists, the Home charts),
 * kept as a row per agent so a page reads one table and touches no actor.
 *
 * - Where the actors run, `startAgentSummaryPublisher` hears every feed event
 *   about an agent and publishes one `agent_summary` event with the agent's
 *   summary as of then (coalesced: a burst of events costs one `live()`).
 * - Where the database is, `startAgentSummaryWriter` stores each summary.
 * - Pages find summaries through `agentSummarySource()`. By default it keeps
 *   none, so every agent is asked, as before; a deployment whose actors are
 *   costly to reach installs `storedAgentSummaries` at boot.
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
import type { ApiAgentDashboard, ApiAgentWidget } from '@shared/lib/types/api'
import type { AutomationRun } from './automation-runs'

export const AGENT_SUMMARY_EVENT = 'agent_summary'

export interface AgentSummary {
  container: Pick<AgentLiveSummary['container'], 'status' | 'port' | 'healthWarnings' | 'stale'>
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
  /** Sessions waiting on the user, so a list can preview the question behind the flag. */
  awaitingSessionIds: string[]
  sessionCount: number
  lastActivityAt: string | null
  /** The sessions an agent list shows (hidden automated ones left out): only their unread notifications count. */
  visibleSessionIds: string[]
  dashboards: ApiAgentDashboard[]
  widgets: ApiAgentWidget[]
  /** The cron and webhook runs its Home charts are drawn from. Absent in rows stored before charts read them. */
  automationRuns?: AutomationRun[]
}

export function agentSummaryOf(
  live: AgentLiveSummary,
  sessions: { sessionCount: number; lastActivityAt: Date | null },
  listing: Pick<AgentSummary, 'visibleSessionIds' | 'dashboards' | 'widgets' | 'automationRuns'>,
): AgentSummary {
  const { status, port, healthWarnings, stale } = live.container
  return {
    container: { status, port, healthWarnings, stale },
    hasActiveSessions: live.activeSessionIds.length > 0,
    hasSessionsAwaitingInput: live.awaitingSessionIds.length > 0 || live.pendingReviews.length > 0,
    awaitingSessionIds: [...live.awaitingSessionIds],
    sessionCount: sessions.sessionCount,
    lastActivityAt: sessions.lastActivityAt?.toISOString() ?? null,
    ...listing,
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
    background(storeAgentSummary(event.agentSlug, event.summary as AgentSummary), { name: 'agent-summaries.write' })
  })
}

/** Store one agent's summary, replacing the one before. */
export async function storeAgentSummary(slug: AgentSlug, summary: AgentSummary): Promise<void> {
  const row = { summary: JSON.stringify(summary), updatedAt: new Date() }
  await db.insert(agentSummaries).values({ agentSlug: slug, ...row }).onConflictDoUpdate({ target: agentSummaries.agentSlug, set: row })
}

export async function readAgentSummaries(slugs: readonly AgentSlug[]): Promise<Map<AgentSlug, AgentSummary>> {
  if (slugs.length === 0) return new Map()
  const rows = await db.select().from(agentSummaries).where(inArray(agentSummaries.agentSlug, [...slugs])).all()
  return new Map(rows.map((row) => [row.agentSlug, { awaitingSessionIds: [], ...(JSON.parse(row.summary) as Partial<AgentSummary>) } as AgentSummary]))
}

/** Where pages find agents' summaries before asking the agents themselves. */
export interface AgentSummarySource {
  /** The summaries kept for these agents. An agent missing here is asked. */
  known(slugs: readonly AgentSlug[]): Promise<Map<AgentSlug, AgentSummary>>
  /** Keep a summary just read from an agent, so the next page finds it. */
  keep(slug: AgentSlug, summary: AgentSummary): Promise<void>
}

const askEveryAgent: AgentSummarySource = {
  known: async () => new Map(),
  keep: async () => {},
}

/** The summaries in the `agent_summaries` table. */
export const storedAgentSummaries: AgentSummarySource = {
  known: (slugs) => readAgentSummaries(slugs),
  keep: (slug, summary) => storeAgentSummary(slug, summary),
}

let source = askEveryAgent

/** Install where pages find summaries; `null` asks every agent again. */
export function setAgentSummarySource(next: AgentSummarySource | null): void {
  source = next ?? askEveryAgent
}

export function agentSummarySource(): AgentSummarySource {
  return source
}
