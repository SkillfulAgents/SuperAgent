export const RUNTIME_DEATH_REASONS = ['max_lifetime', 'guest_oom', 'runtime_lost'] as const

export type RecoverableDeathReason = (typeof RUNTIME_DEATH_REASONS)[number]

// Fatal kind the agent process reported just before the runtime died, if any.
export type RuntimeFatalKind = 'oom_sigkill' | null

export type UnexpectedDeathPlan =
  | { action: 'ignore' }
  | { action: 'settle' }
  | {
      action: 'recover'
      reason: RecoverableDeathReason
      replaceGeneration: boolean
    }

export type ObserveUnexpectedDeathInput = {
  lastFatalResult?: RuntimeFatalKind
  sessionIds?: string[]
}

export const RECOVERY_PROMPTS: Record<RecoverableDeathReason, string> = {
  max_lifetime:
    'The previous turn was cut off because the runtime hit its 8-hour lifetime. Continue from where you left off. Check what already completed before redoing work.',
  guest_oom:
    'The previous turn was killed because the process ran out of memory. Continue from where you left off, and avoid large in-memory work or huge tool payloads. Check what already completed before redoing work.',
  runtime_lost:
    'The previous turn was interrupted because the runtime stopped unexpectedly. Continue from where you left off. Check what already completed before redoing work.',
}

export function buildRecoveryPrompt(
  reason: RecoverableDeathReason,
  coalescedUserMessage?: string,
): string {
  const base = RECOVERY_PROMPTS[reason]
  const extra = coalescedUserMessage?.trim()
  if (!extra) return base
  return `${base}\n\nThe user also sent:\n${extra}`
}

export function inferOomSigkillFatal(content: { fatal?: unknown; error?: unknown }): boolean {
  if (content.fatal !== true) return false
  const err = String(content.error ?? '')
  return err.includes('SIGKILL') || err.includes('running out of memory')
}
