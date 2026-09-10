import { randomUUID } from 'crypto'
import { containerManager } from './container-manager'
import { messagePersister } from './message-persister'
import { syncAgentConnectionEnvironment, type ConnectionRuntimeKind } from './connection-runtime-sync'
import type { ContainerClient } from './types'
import { buildConnectionReplacementMessage } from '@shared/lib/utils/connection-replacement-message'

export interface ConnectionReplacement {
  agentSlug: string
  kind: ConnectionRuntimeKind
  name: string
  previousId: string
  replacementId: string
}

/** Refresh the runtime, interrupt its active turns, then deliver the new identity.
 * Releasing parked calls after the interrupts prevents a stale tool result from
 * driving a continuation before the system message. Idle sessions pick up the
 * new projection on their next normal message; replacement does not wake them. */
export async function finishConnectionReplacement(
  change: ConnectionReplacement,
  releaseRequests: () => void,
): Promise<{ liveRefresh: boolean; sessionNotification: boolean }> {
  const { agentSlug } = change
  let liveRefresh = false
  let sessionNotification = true
  const ready: Array<{ sessionId: string; client: ContainerClient }> = []
  try {
    const sessionIds = messagePersister.getActiveSessionIdsForAgent(agentSlug)
    liveRefresh = await syncAgentConnectionEnvironment(agentSlug, change.kind)
    if (!liveRefresh) return { liveRefresh: false, sessionNotification: false }
    if (sessionIds.length === 0 || containerManager.getCachedInfo(agentSlug).status !== 'running') {
      return { liveRefresh: true, sessionNotification: true }
    }

    const client = containerManager.getClient(agentSlug)
    const interrupted = await Promise.allSettled(sessionIds.map(async (sessionId) => {
      // A user may have stopped a session while the projection was being updated.
      if (!messagePersister.isSessionActive(agentSlug, sessionId)) return null
      const turnGenerationBefore = messagePersister.getTurnGeneration(agentSlug, sessionId)
      const result = await client.interruptSession(sessionId, { scope: 'turn' })
      if (!result.interrupted) throw new Error(`Failed to interrupt session ${sessionId}`)
      await messagePersister.markSessionInterrupted(agentSlug, sessionId, {
        processKept: result.processKept,
        turnGenerationBefore,
      })
      return sessionId
    }))
    for (const result of interrupted) {
      if (result.status === 'rejected') {
        sessionNotification = false
        console.warn('[ConnectionReplacement] Failed to interrupt a session:', result.reason)
      } else if (result.value) {
        ready.push({ sessionId: result.value, client })
      }
    }
  } catch (error) {
    console.warn('[ConnectionReplacement] Failed to prepare session notifications:', error)
    return { liveRefresh, sessionNotification: false }
  } finally {
    // The mapping has already changed. Never leave a parked call waiting for
    // the removed connection, even if runtime preparation fails unexpectedly.
    releaseRequests()
  }

  const deliveries = await Promise.allSettled(ready.map(({ sessionId, client }) =>
    messagePersister.withSessionSend(agentSlug, sessionId, client, () =>
      client.sendMessage(sessionId, buildConnectionReplacementMessage(change), randomUUID(), { shouldQuery: true }),
    ),
  ))
  for (const result of deliveries) {
    if (result.status === 'rejected') {
      sessionNotification = false
      console.warn('[ConnectionReplacement] Failed to notify a session:', result.reason)
    }
  }
  return { liveRefresh, sessionNotification }
}
