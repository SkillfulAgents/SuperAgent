/**
 * What pages that show many agents need of each one (agent lists), kept as a
 * row per agent in `agent_summaries`, so such a page reads one table and
 * reaches no actor. The agent's actor stays the owner of the state: a summary
 * is a copy of what it answered, taken where the agent's events are raised.
 *
 * Every summary carries the time its state was read (`revision`). A write is
 * conditional on that: a summary read earlier never replaces one read later,
 * whichever write arrives last. The clock is the wall clock, so the order
 * holds across restarts and between the processes that may write.
 *
 * A row can be missing (an agent no event was raised for yet) or behind (a
 * process that stopped between an event and its write). A reader treats a
 * missing row as "ask the agent" and stores the answer; any later event about
 * the agent replaces a row that is behind.
 */
import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { agentSummaries } from '@shared/lib/db/schema'
import type { AgentLiveSummary, AgentSlug } from '@shared/lib/agent-actor/types'
import type { ApiAgentDashboard, ApiAgentWidget } from '@shared/lib/types/api'

const containerSchema = z.object({
  status: z.string(),
  port: z.number().nullable(),
  healthWarnings: z.array(z.object({ checkName: z.string(), status: z.string() }).passthrough()),
  stale: z.boolean(),
})

/** Only what an agent list shows: no transcript text, no request payloads, no file contents. */
export const agentSummarySchema = z.object({
  container: containerSchema,
  hasActiveSessions: z.boolean(),
  hasSessionsAwaitingInput: z.boolean(),
  /** Sessions waiting on the user, so a list can preview the question behind the flag. */
  awaitingSessionIds: z.array(z.string()),
  sessionCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
  /** The sessions an agent list shows (hidden automated ones left out): only their unread state counts. */
  visibleSessionIds: z.array(z.string()),
  dashboards: z.array(z.object({ slug: z.string(), name: z.string() }).passthrough()),
  widgets: z.array(z.object({ slug: z.string() }).passthrough()),
})

export type AgentSummary = Omit<z.infer<typeof agentSummarySchema>, 'container' | 'dashboards' | 'widgets'> & {
  container: Pick<AgentLiveSummary['container'], 'status' | 'port' | 'healthWarnings' | 'stale'>
  dashboards: ApiAgentDashboard[]
  widgets: ApiAgentWidget[]
}

export function agentSummaryOf(
  live: AgentLiveSummary,
  sessions: { sessionCount: number; lastActivityAt: Date | null },
  listing: Pick<AgentSummary, 'visibleSessionIds' | 'dashboards' | 'widgets'>,
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

let lastRevision = 0
/**
 * A revision for a summary about to be read: take it BEFORE asking the agent,
 * so the summary is never older than its revision says. Never repeats in one
 * process, and follows the wall clock, so it is later than any revision a
 * process that ran before this one took.
 */
export function nextSummaryRevision(now: number = Date.now()): number {
  lastRevision = Math.max(lastRevision + 1, now)
  return lastRevision
}

/** Store a summary unless one read later is stored. True when this one was stored. */
export async function storeAgentSummary(slug: AgentSlug, summary: AgentSummary, revision: number): Promise<boolean> {
  const row = { summary: JSON.stringify(agentSummarySchema.parse(summary)), revision, updatedAt: new Date() }
  const stored = await db
    .insert(agentSummaries)
    .values({ agentSlug: slug, ...row })
    .onConflictDoUpdate({ target: agentSummaries.agentSlug, set: row, setWhere: sql`${agentSummaries.revision} < ${revision}` })
    .returning({ agentSlug: agentSummaries.agentSlug })
    .all()
  return stored.length > 0
}

/**
 * The stored summaries of these agents. A row this build cannot read (a
 * stricter schema, a damaged value) counts as missing, so its agent is asked.
 */
export async function readAgentSummaries(slugs: readonly AgentSlug[]): Promise<Map<AgentSlug, AgentSummary>> {
  const summaries = new Map<AgentSlug, AgentSummary>()
  if (slugs.length === 0) return summaries
  const rows = await db
    .select({ agentSlug: agentSummaries.agentSlug, summary: agentSummaries.summary })
    .from(agentSummaries)
    .where(inArray(agentSummaries.agentSlug, [...slugs]))
    .all()
  for (const row of rows) {
    const parsed = parseStored(row.summary)
    if (parsed) summaries.set(row.agentSlug, parsed)
  }
  return summaries
}

function parseStored(stored: string): AgentSummary | null {
  try {
    const parsed = agentSummarySchema.safeParse(JSON.parse(stored))
    // The schema checks the shape; the container and listing types are narrower than it can say.
    return parsed.success ? (parsed.data as unknown as AgentSummary) : null
  } catch {
    return null
  }
}

/** Drop the summary of an agent that is being removed. */
export async function dropAgentSummary(slug: AgentSlug): Promise<void> {
  await db.delete(agentSummaries).where(eq(agentSummaries.agentSlug, slug)).run()
}
