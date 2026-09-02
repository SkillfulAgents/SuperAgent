type AttemptState = 'in_flight' | 'done'

const DONE_TTL_MS = 30 * 60 * 1000
const MAX_DONE_ATTEMPTS = 1000
const attempts = new Map<string, { state: AttemptState; expiresAt: number | null }>()
const sessionsInFlight = new Set<string>()

function key(attemptId: string, sessionId: string): string {
  return `${sessionId}:${attemptId}`
}

function pruneDoneAttempts(now: number): void {
  for (const [attemptKey, attempt] of attempts) {
    if (attempt.state === 'done' && attempt.expiresAt !== null && attempt.expiresAt <= now) {
      attempts.delete(attemptKey)
    }
  }
  let doneCount = [...attempts.values()].filter((attempt) => attempt.state === 'done').length
  if (doneCount <= MAX_DONE_ATTEMPTS) return
  for (const [attemptKey, attempt] of attempts) {
    if (attempt.state !== 'done') continue
    attempts.delete(attemptKey)
    doneCount--
    if (doneCount <= MAX_DONE_ATTEMPTS) return
  }
}

export function beginBillingResumeAttempt(
  attemptId: string,
  sessionId: string,
  now = Date.now(),
):
  | { ok: true }
  | { ok: false; duplicate: true }
  | { ok: false; duplicate?: false; reason: 'in_flight' | 'session_busy' } {
  pruneDoneAttempts(now)
  const existing = attempts.get(key(attemptId, sessionId))
  if (existing?.state === 'done') return { ok: false, duplicate: true }
  if (existing?.state === 'in_flight') return { ok: false, reason: 'in_flight' }
  if (sessionsInFlight.has(sessionId)) return { ok: false, reason: 'session_busy' }
  attempts.set(key(attemptId, sessionId), { state: 'in_flight', expiresAt: null })
  sessionsInFlight.add(sessionId)
  return { ok: true }
}

export function finishBillingResumeAttempt(
  attemptId: string,
  sessionId: string,
  success: boolean,
  now = Date.now(),
): void {
  sessionsInFlight.delete(sessionId)
  if (success) {
    attempts.set(key(attemptId, sessionId), {
      state: 'done',
      expiresAt: now + DONE_TTL_MS,
    })
    pruneDoneAttempts(now)
  } else {
    attempts.delete(key(attemptId, sessionId))
  }
}

export function resetBillingResumeAttemptsForTests(): void {
  attempts.clear()
  sessionsInFlight.clear()
}
