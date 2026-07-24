/**
 * Shared session-interrupt path - the app Stop button's implementation, factored
 * out of the interrupt route so chat /stop (and busy-/clear) reuse it exactly.
 *
 * The key property: it ALWAYS settles the session locally (markSessionInterrupted
 * + denyAllForAgent), even on a wedged or dead container, so the UI and the chat
 * indicator unstick no matter what the container does.
 *
 * LEAF module: must not be imported by container-manager or message-persister
 * (container-manager already imports message-persister, which lazy-imports back;
 * do not extend that graph).
 */

import { containerManager } from './container-manager'
import { messagePersister } from './message-persister'
import { reviewManager } from '@shared/lib/proxy/review-manager'

export type InterruptOutcome = 'interrupted' | 'container-not-running' | 'error-settled-locally'

/**
 * Bound on the container interrupt call: a wedged container's HTTP request can
 * otherwise hang for minutes (no fetch timeout at the client layer), and /stop
 * must settle the chat's serial inbound queue promptly. A timeout falls into
 * the settle-locally catch below.
 */
export const INTERRUPT_TIMEOUT_MS = 15_000

function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

export async function interruptAgentSession(agentSlug: string, sessionId: string): Promise<InterruptOutcome> {
  try {
    const client = containerManager.getClient(agentSlug)
    // Use cached status to avoid spawning a docker process
    const info = containerManager.getCachedInfo(agentSlug)

    // If the container isn't running, just mark the session as interrupted locally.
    // This handles the case where the container crashed/restarted but the UI still
    // shows the session active.
    if (info.status !== 'running') {
      console.log(`[InterruptSession] Container not running for ${agentSlug}, marking session ${sessionId} as interrupted locally`)
      await messagePersister.markSessionInterrupted(sessionId)
      reviewManager.denyAllForAgent(agentSlug)
      return 'container-not-running'
    }

    // Try to interrupt in the container (bounded - see INTERRUPT_TIMEOUT_MS)
    const interrupted = await raceWithTimeout(client.interruptSession(sessionId), INTERRUPT_TIMEOUT_MS, 'Container interrupt')

    // Even if the container interrupt fails (the session might not exist there
    // anymore), still mark it as interrupted locally to update the UI.
    if (!interrupted) {
      console.log(`[InterruptSession] Container interrupt returned false for session ${sessionId}, marking as interrupted locally`)
    }

    await messagePersister.markSessionInterrupted(sessionId)
    reviewManager.denyAllForAgent(agentSlug)
    return 'interrupted'
  } catch (error) {
    console.error('[InterruptSession] Failed to interrupt session:', error)
    // Even on error, settle locally to fix UI state. If THIS throws too, the
    // caller decides (the API route maps it to a 500).
    await messagePersister.markSessionInterrupted(sessionId)
    reviewManager.denyAllForAgent(agentSlug)
    return 'error-settled-locally'
  }
}
