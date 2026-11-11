/**
 * Keeps `agent_summaries` current: after any event this process raises about
 * an agent, the agent is summarized again and the summary stored.
 *
 * It hears the events where they are raised (`GlobalFeed.onPublished`), not
 * as a feed subscriber: the feed's delivery is best-effort, and a summary must
 * not depend on a hint arriving. A burst of events costs one summary, and a
 * summary equal to the one this process stored last is not written again.
 */
import { background } from '@shared/lib/background'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { GlobalFeed } from '@shared/lib/notifications/global-feed'
import { nextSummaryRevision, storeAgentSummary, type AgentSummary } from './agent-summaries'

export interface AgentSummaryWriterOptions {
  feed: Pick<GlobalFeed, 'onPublished'>
  /** Reads the agent's actor; null for an agent that no longer exists, which stores nothing. */
  summarize: (slug: AgentSlug) => Promise<AgentSummary | null>
  /**
   * Whether this process is where the agent's actor runs. Elsewhere its events
   * are skipped: summarizing would reach across to the actor, and the actor's
   * own process summarizes it anyway. Defaults to every agent (one process).
   */
  owns?: (slug: AgentSlug) => boolean
}

/** Starts the writer; the returned function stops it. */
export function startAgentSummaryWriter({ feed, summarize, owns = () => true }: AgentSummaryWriterOptions): () => void {
  const running = new Set<AgentSlug>()
  const again = new Set<AgentSlug>()
  const lastStored = new Map<AgentSlug, string>()

  const write = async (slug: AgentSlug): Promise<void> => {
    running.add(slug)
    try {
      do {
        // Lets the rest of a burst be raised first: it is all in one summary.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        again.delete(slug)
        const revision = nextSummaryRevision()
        const summary = await summarize(slug)
        if (!summary) {
          lastStored.delete(slug)
          continue
        }
        const json = JSON.stringify(summary)
        if (lastStored.get(slug) === json) continue
        await storeAgentSummary(slug, summary, revision)
        lastStored.set(slug, json)
      } while (again.has(slug))
    } catch (error) {
      // The stored summary stays behind until the agent's next event.
      console.error(`[AgentSummaries] Could not store the summary of ${slug}:`, error)
    } finally {
      running.delete(slug)
    }
  }

  return feed.onPublished((event) => {
    const slug = event.agentSlug
    if (!slug || !owns(slug)) return
    if (running.has(slug)) {
      again.add(slug)
      return
    }
    background(write(slug), { name: 'agent-summaries.write' })
  })
}
