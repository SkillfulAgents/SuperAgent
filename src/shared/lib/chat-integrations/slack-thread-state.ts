import { readIntegrationState, writeIntegrationState } from '../agent-integrations/state-store'
import { and, desc, eq, isNull, like, max } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { chatIntegrationSessions } from '@shared/lib/db/schema'

import { MAX_TRACKED_SLACK_THREADS, slackParticipationSchema } from './slack-thread-state-schema'
export { MAX_TRACKED_SLACK_THREADS } from './slack-thread-state-schema'

export interface SlackThreadStateStore {
  /** Oldest to newest, for the authenticated bot within this installation. */
  load(botUserId: string): Promise<readonly string[]>
  save(botUserId: string, threads: readonly string[]): Promise<void>
}

/** Each installed integration gets its own state; deleting it cascades here. */
export function createSlackThreadStateStore(integrationId: string): SlackThreadStateStore {
  const save: SlackThreadStateStore['save'] = async (botUserId, threads) => {
    const activeThreads = [...threads].slice(-MAX_TRACKED_SLACK_THREADS)
    await writeIntegrationState(integrationId, 'slack:participation', slackParticipationSchema, { botUserId, activeThreads })
  }

  return {
    save,
    async load(botUserId) {
      const state = await readIntegrationState(integrationId, 'slack:participation', slackParticipationSchema)
      if (state?.botUserId === botUserId) return state.activeThreads

      // Upgrade existing per-thread sessions once. Shared-session mode never
      // stored thread anchors, so those threads are remembered when next joined.
      // A replacement bot must not inherit the previous bot's participation.
      const threads = state ? [] : (await db.select({ threadKey: chatIntegrationSessions.externalChatId })
        .from(chatIntegrationSessions)
        .where(and(
          eq(chatIntegrationSessions.integrationId, integrationId),
          isNull(chatIntegrationSessions.archivedAt),
          like(chatIntegrationSessions.externalChatId, '%|%'),
        ))
        .groupBy(chatIntegrationSessions.externalChatId)
        .orderBy(desc(max(chatIntegrationSessions.updatedAt)))
        .limit(MAX_TRACKED_SLACK_THREADS)
        .all())
        .reverse()
        .map(row => row.threadKey)
      // Also save an empty result: later connects must not resurrect evicted or
      // replaced-bot entries by re-reading old session mappings.
      await save(botUserId, threads)
      return threads
    },
  }
}
