/**
 * A proxied call parked on a re-auth card, as the host waits for it: the
 * outcome comes back as data, and an aborted request withdraws its wait.
 */
import { randomUUID } from 'crypto'
import type { ReauthOutcome } from './reauth-waits'
import { background } from '../background'

/** The agent's side of a parked re-auth wait: what the re-auth ops and `AgentReauthWaits` both offer. */
export interface ReauthParking<Details> {
  request(details: Details, options: { waitId: string }): Promise<ReauthOutcome>
  withdraw(waitId: string): unknown
}

/** Park the call until the card's outcome; an aborted request withdraws it (`withdrawn`). */
export async function awaitReauth<Details>(
  waits: ReauthParking<Details>,
  details: Details,
  signal?: AbortSignal,
): Promise<ReauthOutcome> {
  // The caller is already gone: raise no card nobody waits on.
  if (signal?.aborted) return { outcome: 'withdrawn' }
  const waitId = randomUUID()
  const withdraw = () => {
    background(Promise.resolve(waits.withdraw(waitId)).catch((error: unknown) => {
      console.warn('[reauth] Failed to withdraw an aborted wait:', error)
    }), { name: 'reauth-request.withdraw-wait' })
  }
  signal?.addEventListener('abort', withdraw, { once: true })
  try {
    return await waits.request(details, { waitId })
  } finally {
    signal?.removeEventListener('abort', withdraw)
  }
}
