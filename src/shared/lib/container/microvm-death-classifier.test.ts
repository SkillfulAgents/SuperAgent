import { describe, expect, it } from 'vitest'
import {
  MICROVM_MAX_LIFETIME_REASON,
  MICROVM_RECOVERY_PROMPTS,
  classifyMicrovmDeath,
  planFromClassification,
} from './microvm-death-classifier'

describe('classifyMicrovmDeath', () => {
  it('classifies TERMINATED + max-lifetime stateReason as max_lifetime', () => {
    expect(
      classifyMicrovmDeath({
        state: 'TERMINATED',
        stateReason: MICROVM_MAX_LIFETIME_REASON,
      }),
    ).toBe('max_lifetime')
  })

  it('classifies TERMINATING + max-lifetime stateReason as max_lifetime', () => {
    expect(
      classifyMicrovmDeath({
        state: 'TERMINATING',
        stateReason: `  ${MICROVM_MAX_LIFETIME_REASON}  `,
      }),
    ).toBe('max_lifetime')
  })

  it('does not treat operator Success. as max_lifetime', () => {
    expect(
      classifyMicrovmDeath({ state: 'TERMINATED', stateReason: 'Success.' }),
    ).toBe('runtime_lost')
  })

  it('classifies SIGKILL + RUNNING + idle probe as guest_oom', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        lastFatalResult: 'oom_sigkill',
        probe: { status: 'idle', liveSessionIds: [] },
      }),
    ).toBe('guest_oom')
  })

  it('classifies SIGKILL + RUNNING + unreachable probe as guest_oom', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        lastFatalResult: 'oom_sigkill',
        probe: { status: 'unreachable' },
      }),
    ).toBe('guest_oom')
  })

  it('does not classify guest_oom from a WS drop while the probe sees a live session', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        lastFatalResult: 'oom_sigkill',
        probe: { status: 'live', liveSessionIds: ['sess-1'] },
      }),
    ).toBe('not_dead')
  })

  it('does not classify guest_oom from a dead probe without a SIGKILL result', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        probe: { status: 'idle', liveSessionIds: [] },
      }),
    ).toBe('not_dead')
  })

  it('classifies TERMINATED without a max-lifetime reason as runtime_lost', () => {
    expect(classifyMicrovmDeath({ state: 'TERMINATED' })).toBe('runtime_lost')
    expect(classifyMicrovmDeath({ state: 'TERMINATING', stateReason: 'Success.' })).toBe(
      'runtime_lost',
    )
  })

  it('classifies GetMicrovm 404 as runtime_lost', () => {
    expect(classifyMicrovmDeath({ notFound: true })).toBe('runtime_lost')
  })

  it('classifies a live VM as not_dead', () => {
    expect(classifyMicrovmDeath({ state: 'RUNNING', probe: { status: 'live' } })).toBe('not_dead')
    expect(classifyMicrovmDeath({ state: 'SUSPENDED' })).toBe('not_dead')
    expect(classifyMicrovmDeath({})).toBe('not_dead')
  })
})

describe('planFromClassification', () => {
  it('recovers max_lifetime and runtime_lost with replace and reason-specific prompts', () => {
    expect(planFromClassification('max_lifetime')).toEqual({
      action: 'recover',
      reason: 'max_lifetime',
      resumePrompt: MICROVM_RECOVERY_PROMPTS.max_lifetime,
      replaceGeneration: true,
    })
    expect(MICROVM_RECOVERY_PROMPTS.max_lifetime).toContain('8-hour lifetime')
    expect(planFromClassification('runtime_lost')).toEqual({
      action: 'recover',
      reason: 'runtime_lost',
      resumePrompt: MICROVM_RECOVERY_PROMPTS.runtime_lost,
      replaceGeneration: true,
    })
  })

  it('recovers guest_oom without replace only while the container HTTP surface is up', () => {
    expect(planFromClassification('guest_oom', { probe: { status: 'idle', liveSessionIds: [] } })).toEqual({
      action: 'recover',
      reason: 'guest_oom',
      resumePrompt: MICROVM_RECOVERY_PROMPTS.guest_oom,
      replaceGeneration: false,
    })
  })

  it('recovers guest_oom with replace when the container HTTP surface is unreachable', () => {
    expect(planFromClassification('guest_oom', { probe: { status: 'unreachable' } })).toEqual({
      action: 'recover',
      reason: 'guest_oom',
      resumePrompt: MICROVM_RECOVERY_PROMPTS.guest_oom,
      replaceGeneration: true,
    })
  })

  it('ignores a live RUNNING probe with its live-session list and settles other not_dead cases', () => {
    expect(
      planFromClassification('not_dead', {
        state: 'RUNNING',
        probe: { status: 'live', liveSessionIds: ['sess-1'] },
      }),
    ).toEqual({ action: 'ignore', liveSessionIds: ['sess-1'] })
    expect(
      planFromClassification('not_dead', { state: 'RUNNING', probe: { status: 'live' } }),
    ).toEqual({ action: 'ignore', liveSessionIds: undefined })
    expect(
      planFromClassification('not_dead', {
        state: 'RUNNING',
        probe: { status: 'idle', liveSessionIds: [] },
      }),
    ).toEqual({ action: 'settle' })
    expect(planFromClassification('not_dead', { state: 'SUSPENDED' })).toEqual({ action: 'settle' })
  })
})
