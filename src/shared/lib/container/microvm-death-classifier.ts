import type { RuntimeDeathProbe, RuntimeFatalKind, UnexpectedDeathPlan } from './runtime-death'

export const MICROVM_DEATH_REASONS = ['max_lifetime', 'guest_oom', 'runtime_lost', 'not_dead'] as const

export type MicrovmDeathReason = (typeof MICROVM_DEATH_REASONS)[number]

export type MicrovmFatalResult = RuntimeFatalKind

// Verified in SUP-571: GetMicrovm stateReason when AWS hits the 8h cap.
export const MICROVM_MAX_LIFETIME_REASON = 'MicroVM exceeded maximum lifetime.'

export const MICROVM_RECOVERY_PROMPTS: Record<Exclude<MicrovmDeathReason, 'not_dead'>, string> = {
  max_lifetime:
    'The previous turn was cut off because the runtime hit its 8-hour lifetime. Continue from where you left off. Check what already completed before redoing work.',
  guest_oom:
    'The previous turn was killed because the process ran out of memory. Continue from where you left off, and avoid large in-memory work or huge tool payloads. Check what already completed before redoing work.',
  runtime_lost:
    'The previous turn was interrupted because the runtime stopped unexpectedly. Continue from where you left off. Check what already completed before redoing work.',
}

const TERMINAL = new Set(['TERMINATED', 'TERMINATING'])

export type ClassifyMicrovmDeathInput = {
  state?: string | null
  stateReason?: string | null
  lastFatalResult?: MicrovmFatalResult
  probe?: RuntimeDeathProbe | null
  notFound?: boolean
}

export function isMaxLifetimeReason(stateReason: string | null | undefined): boolean {
  return stateReason?.trim() === MICROVM_MAX_LIFETIME_REASON
}

export function classifyMicrovmDeath(input: ClassifyMicrovmDeathInput): MicrovmDeathReason {
  if (isMaxLifetimeReason(input.stateReason)) return 'max_lifetime'

  const running = input.state === 'RUNNING'
  const probeStatus = input.probe?.status
  const sessionDead = probeStatus === 'idle' || probeStatus === 'unreachable'
  if (running && input.lastFatalResult === 'oom_sigkill' && sessionDead) {
    return 'guest_oom'
  }

  if (input.notFound || TERMINAL.has(input.state ?? '')) return 'runtime_lost'
  return 'not_dead'
}

export function planFromClassification(
  reason: MicrovmDeathReason,
  opts?: { probe?: RuntimeDeathProbe | null; state?: string | null },
): UnexpectedDeathPlan {
  if (reason !== 'not_dead') {
    // guest_oom with the container HTTP surface still up: the VM survived and
    // can accept a resume in place. If HTTP is down too, replace the VM —
    // resuming against a dead endpoint would only fail into settle.
    const keepGeneration = reason === 'guest_oom' && opts?.probe?.status === 'idle'
    return {
      action: 'recover',
      reason,
      resumePrompt: MICROVM_RECOVERY_PROMPTS[reason],
      replaceGeneration: !keepGeneration,
    }
  }
  if (opts?.state === 'RUNNING' && opts?.probe?.status === 'live') {
    return { action: 'ignore', liveSessionIds: opts.probe.liveSessionIds }
  }
  return { action: 'settle' }
}
