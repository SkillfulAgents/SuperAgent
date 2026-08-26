import { z } from 'zod'

/**
 * The invoked sessions a session wake is waiting on. Stored as a JSON string in
 * scheduled_tasks.wake_on_sessions; this module is the only reader and writer.
 */

const wakeOutcomeSchema = z.enum(['completed', 'errored', 'unknown', 'deleted'])
export type WakeOutcome = z.infer<typeof wakeOutcomeSchema>

const wakeTargetSchema = z.object({
  agentSlug: z.string(),
  sessionId: z.string(),
  // uuid of the target's last assistant entry before our prompt went out, so
  // the reply read at wake time is this turn's, not the previous one's.
  boundaryUuid: z.string().optional(),
  outcome: wakeOutcomeSchema.optional(),
})
export type WakeTarget = z.infer<typeof wakeTargetSchema>

const wakeOnSessionsSchema = z.object({
  targets: z.array(wakeTargetSchema),
  // ISO time of the clock wake this row carried when its targets made it due.
  // Re-created as a fresh timed wake after delivery.
  deferredTimerAt: z.string().datetime().optional(),
})
export type WakeOnSessions = z.infer<typeof wakeOnSessionsSchema>

export function parseWakeOnSessions(raw: string | null): WakeOnSessions | null {
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    console.error('[wake-on-sessions] malformed JSON in wake_on_sessions')
    return null
  }
  const parsed = wakeOnSessionsSchema.safeParse(json)
  if (!parsed.success) {
    console.error('[wake-on-sessions] invalid shape in wake_on_sessions:', parsed.error.message)
    return null
  }
  return parsed.data
}

export function serializeWakeOnSessions(value: WakeOnSessions): string {
  // Validate on the way in too: a bad value written here would be dropped as
  // null by every later parse, and the wake with it.
  return JSON.stringify(wakeOnSessionsSchema.parse(value))
}

export function openTargets(value: WakeOnSessions): WakeTarget[] {
  return value.targets.filter((t) => t.outcome === undefined)
}
