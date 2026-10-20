import { randomUUID } from 'crypto'
import { agentRegistry } from '@shared/lib/agent-actor'
import type { ConnectionRuntimeKind } from './connection-runtime-sync'
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
  const actor = agentRegistry.get(change.agentSlug)
  let liveRefresh = false
  let sessionNotification = true
  const ready: string[] = []
  try {
    const sessionIds = actor.sessions.activeIds()
    liveRefresh = await actor.container.syncConnectionEnvironment(change.kind)
    if (!liveRefresh) return { liveRefresh: false, sessionNotification: false }
    if (sessionIds.length === 0 || actor.container.status().status !== 'running') {
      return { liveRefresh: true, sessionNotification: true }
    }

    const interrupted = await Promise.allSettled(sessionIds.map(async (sessionId) => {
      // A user may have stopped a session while the projection was being updated.
      const result = await actor.messages.stop(sessionId, { scope: 'turn', ifActive: true })
      if (result.path === 'skipped-idle') return null
      if (!result.interrupted) throw new Error(`Failed to interrupt session ${sessionId}`)
      return sessionId
    }))
    for (const result of interrupted) {
      if (result.status === 'rejected') {
        sessionNotification = false
        console.warn('[ConnectionReplacement] Failed to interrupt a session:', result.reason)
      } else if (result.value) {
        ready.push(result.value)
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

  const deliveries = await Promise.allSettled(ready.map((sessionId) =>
    actor.messages.deliver({
      sessionId,
      content: buildConnectionReplacementMessage(change),
      uuid: randomUUID(),
      options: { shouldQuery: true },
    }),
  ))
  for (const result of deliveries) {
    if (result.status === 'rejected') {
      sessionNotification = false
      console.warn('[ConnectionReplacement] Failed to notify a session:', result.reason)
    }
  }
  return { liveRefresh, sessionNotification }
}
