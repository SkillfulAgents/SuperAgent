// Fatal kind the agent process reported just before the runtime died, if any.
export type RuntimeFatalKind = 'oom_sigkill' | null

// Reason vocabularies and prompt text are runtime-specific and live with each
// runtime (e.g. microvm-death-classifier.ts); the generic contract only carries them.
export type UnexpectedDeathPlan =
  | { action: 'ignore' }
  | { action: 'settle' }
  | {
      action: 'recover'
      // Free-form, for telemetry.
      reason: string
      resumePrompt: string
      replaceGeneration: boolean
    }

export type ObserveUnexpectedDeathInput = {
  lastFatalResult?: RuntimeFatalKind
  sessionIds?: string[]
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
