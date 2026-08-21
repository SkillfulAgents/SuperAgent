import { describe, expect, it } from 'vitest'
import {
  MICROVM_MAX_LIFETIME_REASON,
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

  it('classifies SIGKILL + RUNNING + failed probe as guest_oom', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        lastFatalResult: 'oom_sigkill',
        probeResult: 'fail',
      }),
    ).toBe('guest_oom')
  })

  it('does not classify guest_oom from a WS drop while the probe succeeds', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        lastFatalResult: 'oom_sigkill',
        probeResult: 'ok',
      }),
    ).toBe('not_dead')
  })

  it('does not classify guest_oom from probe fail without a SIGKILL result', () => {
    expect(
      classifyMicrovmDeath({
        state: 'RUNNING',
        probeResult: 'fail',
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
    expect(classifyMicrovmDeath({ state: 'RUNNING', probeResult: 'ok' })).toBe('not_dead')
    expect(classifyMicrovmDeath({ state: 'SUSPENDED' })).toBe('not_dead')
    expect(classifyMicrovmDeath({})).toBe('not_dead')
  })
})

describe('planFromClassification', () => {
  it('recovers max_lifetime and runtime_lost with replace', () => {
    expect(planFromClassification('max_lifetime')).toEqual({
      action: 'recover',
      reason: 'max_lifetime',
      replaceGeneration: true,
    })
    expect(planFromClassification('runtime_lost')).toEqual({
      action: 'recover',
      reason: 'runtime_lost',
      replaceGeneration: true,
    })
  })

  it('recovers guest_oom without replace', () => {
    expect(planFromClassification('guest_oom')).toEqual({
      action: 'recover',
      reason: 'guest_oom',
      replaceGeneration: false,
    })
  })

  it('ignores a live RUNNING probe and settles other not_dead cases', () => {
    expect(planFromClassification('not_dead', { state: 'RUNNING', probeResult: 'ok' })).toEqual({
      action: 'ignore',
    })
    expect(planFromClassification('not_dead', { state: 'RUNNING', probeResult: 'fail' })).toEqual({
      action: 'settle',
    })
    expect(planFromClassification('not_dead', { state: 'SUSPENDED' })).toEqual({ action: 'settle' })
  })
})
