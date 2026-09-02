import { z } from 'zod'

const STORAGE_KEY = 'superagent.billing-resume'
const TTL_MS = 30 * 60 * 1000

export const billingResumeTargetSchema = z.object({
  agentSlug: z.string().min(1),
  sessionId: z.string().min(1),
  attemptId: z.string().uuid(),
  initialAllowed: z.boolean(),
  createdAt: z.number(),
  expiresAt: z.number(),
})

export type BillingResumeTarget = z.infer<typeof billingResumeTargetSchema>

let memoryTarget: BillingResumeTarget | null = null

function storage(): Storage | undefined {
  try {
    return sessionStorage
  } catch {
    return undefined
  }
}

function persist(target: BillingResumeTarget | null): void {
  memoryTarget = target
  const session = storage()
  if (!session) return
  try {
    if (!target) session.removeItem(STORAGE_KEY)
    else session.setItem(STORAGE_KEY, JSON.stringify(target))
  } catch {
    // Restricted storage still keeps the in-memory copy for this tab.
  }
}

function readStored(): BillingResumeTarget | null {
  const session = storage()
  if (session) {
    try {
      const raw = session.getItem(STORAGE_KEY)
      if (raw != null) {
        const parsed = billingResumeTargetSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return parsed.data
        session.removeItem(STORAGE_KEY)
      }
    } catch {
      session.removeItem(STORAGE_KEY)
    }
  }
  return memoryTarget
}

export function rememberBillingResumeTarget(input: {
  agentSlug: string
  sessionId: string
  initialAllowed?: boolean
}): BillingResumeTarget {
  const now = Date.now()
  const target: BillingResumeTarget = {
    agentSlug: input.agentSlug,
    sessionId: input.sessionId,
    attemptId: crypto.randomUUID(),
    initialAllowed: input.initialAllowed ?? false,
    createdAt: now,
    expiresAt: now + TTL_MS,
  }
  persist(target)
  return target
}

export function getBillingResumeTarget(): BillingResumeTarget | null {
  const target = readStored()
  if (!target) return null
  if (Date.now() > target.expiresAt) {
    persist(null)
    return null
  }
  return target
}

export function clearBillingResumeTarget(
  target?: Pick<BillingResumeTarget, 'agentSlug' | 'sessionId'> | Pick<BillingResumeTarget, 'attemptId'>,
): void {
  const current = readStored()
  if (!current) return
  if (!target) {
    persist(null)
    return
  }
  if ('attemptId' in target && target.attemptId === current.attemptId) {
    persist(null)
    return
  }
  if (
    'agentSlug' in target
    && target.agentSlug === current.agentSlug
    && target.sessionId === current.sessionId
  ) {
    persist(null)
  }
}

export function resetBillingResumeTargetForTests(): void {
  memoryTarget = null
  storage()?.removeItem(STORAGE_KEY)
}
