import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'
import {
  getBillingResumeTarget,
  type BillingResumeTarget,
} from '@renderer/lib/billing-resume-target'

export const BILLING_GATE_POLL_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000] as const

export type RecoveryOutcome = 'resumed' | 'waiting' | 'aborted' | 'idle'

let inFlight = false
let testDelays: readonly number[] | null = null

export function resetBillingRecoveryForTests(): void {
  inFlight = false
  testDelays = null
}

export function setBillingRecoveryDelaysForTests(delays: readonly number[] | null): void {
  testDelays = delays
}

export function decideBillingResume(
  snapshot: BillingInfoResponse,
  target: Pick<BillingResumeTarget, 'initialAllowed' | 'expiresAt'>,
  now = Date.now(),
): 'resume' | 'wait' | 'abort' {
  if (now > target.expiresAt) return 'abort'
  const access = snapshot.billing?.access
  if (!access) return 'abort'
  if (access.allowed && !target.initialAllowed) return 'resume'
  if (access.allowed) return 'abort'
  return 'wait'
}

export async function recoverAfterBillingEvent(opts: {
  refresh: () => Promise<BillingInfoResponse>
  resume: (target: BillingResumeTarget) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  delays?: readonly number[]
  now?: () => number
}): Promise<RecoveryOutcome> {
  if (inFlight) return 'idle'
  const target = getBillingResumeTarget()
  if (!target) return 'idle'

  inFlight = true
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const delays = opts.delays ?? testDelays ?? BILLING_GATE_POLL_DELAYS_MS
  const now = opts.now ?? Date.now
  try {
    for (const delay of delays) {
      if (delay > 0) await sleep(delay)
      const decision = decideBillingResume(await opts.refresh(), target, now())
      if (decision === 'resume') return (await opts.resume(target)) ? 'resumed' : 'waiting'
      if (decision === 'abort') return 'aborted'
    }
    return 'waiting'
  } finally {
    inFlight = false
  }
}
