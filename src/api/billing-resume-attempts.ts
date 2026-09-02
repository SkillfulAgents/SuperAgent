type AttemptState = 'in_flight' | 'done'

const attempts = new Map<string, AttemptState>()
const sessionsInFlight = new Set<string>()

export function beginBillingResumeAttempt(
  attemptId: string,
  sessionId: string,
):
  | { ok: true }
  | { ok: false; duplicate: true }
  | { ok: false; duplicate?: false; reason: 'in_flight' | 'session_busy' } {
  const existing = attempts.get(attemptId)
  if (existing === 'done') return { ok: false, duplicate: true }
  if (existing === 'in_flight') return { ok: false, reason: 'in_flight' }
  if (sessionsInFlight.has(sessionId)) return { ok: false, reason: 'session_busy' }
  attempts.set(attemptId, 'in_flight')
  sessionsInFlight.add(sessionId)
  return { ok: true }
}

export function finishBillingResumeAttempt(
  attemptId: string,
  sessionId: string,
  success: boolean,
): void {
  sessionsInFlight.delete(sessionId)
  if (success) attempts.set(attemptId, 'done')
  else attempts.delete(attemptId)
}

export function resetBillingResumeAttemptsForTests(): void {
  attempts.clear()
  sessionsInFlight.clear()
}
