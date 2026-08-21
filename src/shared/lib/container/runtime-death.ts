export const RUNTIME_DEATH_REASONS = ['guest_oom', 'runtime_lost'] as const

export type RecoverableDeathReason = (typeof RUNTIME_DEATH_REASONS)[number]

// Fatal kind the agent process reported just before the runtime died, if any.
export type RuntimeFatalKind = 'oom_sigkill' | null

export type UnexpectedDeathPlan =
  | { action: 'ignore' }
  | { action: 'settle' }
  | {
      action: 'recover'
      // Free-form for telemetry; runtimes may add reasons beyond RUNTIME_DEATH_REASONS.
      reason: string
      resumePrompt: string
      replaceGeneration: boolean
    }

export type ObserveUnexpectedDeathInput = {
  lastFatalResult?: RuntimeFatalKind
  sessionIds?: string[]
}

export const RECOVERY_PROMPTS: Record<RecoverableDeathReason, string> = {
  guest_oom:
    'The previous turn was killed because the process ran out of memory. Continue from where you left off, and avoid large in-memory work or huge tool payloads. Check what already completed before redoing work.',
  runtime_lost:
    'The previous turn was interrupted because the runtime stopped unexpectedly. Continue from where you left off. Check what already completed before redoing work.',
}

export function buildRecoveryPrompt(resumePrompt: string, coalescedUserMessage?: string): string {
  const extra = coalescedUserMessage?.trim()
  if (!extra) return resumePrompt
  return `${resumePrompt}\n\nThe user also sent:\n${extra}`
}

// Contract with agent-container's fatal error wording (locked by runtime-death.test.ts).
// If the container ever emits a structured fatal kind, switch to that instead.
export function inferOomSigkillFatal(content: { fatal?: unknown; error?: unknown }): boolean {
  if (content.fatal !== true) return false
  const err = String(content.error ?? '')
  return err.includes('SIGKILL') || err.includes('running out of memory')
}
