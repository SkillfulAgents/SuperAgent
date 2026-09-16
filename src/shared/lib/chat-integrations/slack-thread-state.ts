import { and, desc, eq, isNull, like, max } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrationSessions, slackThreadState } from '@shared/lib/db/schema'

export const MAX_TRACKED_SLACK_THREADS = 1000

export interface SlackThreadStateStore {
  /** Oldest to newest, for the authenticated bot within this installation. */
  load(botUserId: string): readonly string[]
  save(botUserId: string, threads: readonly string[]): void
}

/** Each installed integration gets its own state; deleting it cascades here. */
export function createSlackThreadStateStore(integrationId: string): SlackThreadStateStore {
  const save: SlackThreadStateStore['save'] = (botUserId, threads) => {
    const activeThreads = [...threads].slice(-MAX_TRACKED_SLACK_THREADS)
    db.insert(slackThreadState).values({ integrationId, botUserId, activeThreads })
      .onConflictDoUpdate({ target: slackThreadState.integrationId, set: { botUserId, activeThreads } })
      .run()
  }

  return {
    save,
    load(botUserId) {
      const state = db.select().from(slackThreadState)
        .where(eq(slackThreadState.integrationId, integrationId)).get()
      if (state?.botUserId === botUserId) return state.activeThreads

      // Upgrade existing per-thread sessions once. Shared-session mode never
      // stored thread anchors, so those threads are remembered when next joined.
      // A replacement bot must not inherit the previous bot's participation.
      const threads = state ? [] : db.select({ threadKey: chatIntegrationSessions.externalChatId })
        .from(chatIntegrationSessions)
        .where(and(
          eq(chatIntegrationSessions.integrationId, integrationId),
          isNull(chatIntegrationSessions.archivedAt),
          like(chatIntegrationSessions.externalChatId, '%|%'),
        ))
        .groupBy(chatIntegrationSessions.externalChatId)
        .orderBy(desc(max(chatIntegrationSessions.updatedAt)))
        .limit(MAX_TRACKED_SLACK_THREADS)
        .all()
        .reverse()
        .map(row => row.threadKey)
      // Also save an empty result: later connects must not resurrect evicted or
      // replaced-bot entries by re-reading old session mappings.
      save(botUserId, threads)
      return threads
    },
  }
}
