import {
  RECOVERY_PROMPTS,
  RUNTIME_DEATH_REASONS,
  type RecoverableDeathReason,
  type RuntimeFatalKind,
  type UnexpectedDeathPlan,
} from './runtime-death'

// max_lifetime is MicroVM-specific (AWS 8h cap); it extends the generic reasons here.
export const MICROVM_DEATH_REASONS = ['max_lifetime', ...RUNTIME_DEATH_REASONS, 'not_dead'] as const

export type MicrovmDeathReason = 'max_lifetime' | RecoverableDeathReason | 'not_dead'

export type MicrovmFatalResult = RuntimeFatalKind
export type MicrovmProbeResult = 'ok' | 'fail' | null

// Verified in SUP-571: GetMicrovm stateReason when AWS hits the 8h cap.
export const MICROVM_MAX_LIFETIME_REASON = 'MicroVM exceeded maximum lifetime.'

export const MICROVM_RECOVERY_PROMPTS: Record<Exclude<MicrovmDeathReason, 'not_dead'>, string> = {
  max_lifetime:
    'The previous turn was cut off because the runtime hit its 8-hour lifetime. Continue from where you left off. Check what already completed before redoing work.',
  ...RECOVERY_PROMPTS,
}

const TERMINAL = new Set(['TERMINATED', 'TERMINATING'])

export type ClassifyMicrovmDeathInput = {
  state?: string | null
  stateReason?: string | null
  lastFatalResult?: MicrovmFatalResult
  probeResult?: MicrovmProbeResult
  notFound?: boolean
}

export function isMaxLifetimeReason(stateReason: string | null | undefined): boolean {
  return stateReason?.trim() === MICROVM_MAX_LIFETIME_REASON
}

export function classifyMicrovmDeath(input: ClassifyMicrovmDeathInput): MicrovmDeathReason {
  if (isMaxLifetimeReason(input.stateReason)) return 'max_lifetime'

  const running = input.state === 'RUNNING'
  if (running && input.lastFatalResult === 'oom_sigkill' && input.probeResult === 'fail') {
    return 'guest_oom'
  }

  if (input.notFound || TERMINAL.has(input.state ?? '')) return 'runtime_lost'
  return 'not_dead'
}

export function planFromClassification(
  reason: MicrovmDeathReason,
  opts?: { probeResult?: MicrovmProbeResult; state?: string | null },
): UnexpectedDeathPlan {
  if (reason !== 'not_dead') {
    return {
      action: 'recover',
      reason,
      resumePrompt: MICROVM_RECOVERY_PROMPTS[reason],
      replaceGeneration: reason !== 'guest_oom',
    }
  }
  if (opts?.state === 'RUNNING' && opts.probeResult === 'ok') return { action: 'ignore' }
  return { action: 'settle' }
}
