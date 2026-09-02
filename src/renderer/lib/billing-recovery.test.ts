import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  rememberBillingResumeTarget,
  resetBillingResumeTargetForTests,
} from './billing-resume-target'
import {
  decideBillingResume,
  recoverAfterBillingEvent,
  resetBillingRecoveryForTests,
} from './billing-recovery'
import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'

function snapshot(access?: { allowed: boolean; reason: 'current_pool' | 'insufficient_balance' }): BillingInfoResponse {
  return {
    connected: true,
    billing: {
      configured: true,
      subscription: { status: 'active', paymentStatus: 'current', currentPeriodEnd: null },
      seat: { balanceCents: 5000, startingBalanceCents: 5000 },
      orgPool: { poolBalanceCents: 99999 },
      access,
    },
  }
}

const target = {
  initialAllowed: false,
  expiresAt: Date.parse('2026-09-01T12:30:00.000Z'),
}

beforeEach(() => {
  resetBillingResumeTargetForTests()
  resetBillingRecoveryForTests()
})

afterEach(() => {
  resetBillingResumeTargetForTests()
  resetBillingRecoveryForTests()
})

describe('decideBillingResume', () => {
  it('waits while the gate stays denied', () => {
    expect(decideBillingResume(
      snapshot({ allowed: false, reason: 'insufficient_balance' }),
      target,
      Date.parse('2026-09-01T12:00:00.000Z'),
    )).toBe('wait')
  })

  it('resumes only after a denied gate becomes allowed', () => {
    expect(decideBillingResume(
      snapshot({ allowed: true, reason: 'current_pool' }),
      target,
      Date.parse('2026-09-01T12:00:00.000Z'),
    )).toBe('resume')
  })

  it('does not resume from a positive balance when access is missing', () => {
    expect(decideBillingResume(snapshot(), target, Date.parse('2026-09-01T12:00:00.000Z'))).toBe('abort')
  })

  it('does not resume when the gate was already allowed at arm time', () => {
    expect(decideBillingResume(
      snapshot({ allowed: true, reason: 'current_pool' }),
      { ...target, initialAllowed: true },
      Date.parse('2026-09-01T12:00:00.000Z'),
    )).toBe('abort')
  })

  it('aborts after expiry', () => {
    expect(decideBillingResume(
      snapshot({ allowed: true, reason: 'current_pool' }),
      target,
      Date.parse('2026-09-01T12:31:00.000Z'),
    )).toBe('abort')
  })
})

describe('recoverAfterBillingEvent', () => {
  it('polls a stale denied gate until it allows, then resumes once', async () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    const refresh = vi.fn()
      .mockResolvedValueOnce(snapshot({ allowed: false, reason: 'insufficient_balance' }))
      .mockResolvedValueOnce(snapshot({ allowed: true, reason: 'current_pool' }))
    const resume = vi.fn().mockResolvedValue(true)

    await expect(recoverAfterBillingEvent({
      refresh,
      resume,
      sleep: async () => {},
      delays: [0, 0],
    })).resolves.toBe('resumed')
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('does not resume checkout cancel (gate stays denied)', async () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    const resume = vi.fn()
    await expect(recoverAfterBillingEvent({
      refresh: async () => snapshot({ allowed: false, reason: 'insufficient_balance' }),
      resume,
      sleep: async () => {},
      delays: [0, 0, 0],
    })).resolves.toBe('waiting')
    expect(resume).not.toHaveBeenCalled()
  })

  it('ignores a duplicate event while a recovery is in flight', async () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const first = recoverAfterBillingEvent({
      refresh: async () => {
        await blocked
        return snapshot({ allowed: true, reason: 'current_pool' })
      },
      resume: async () => true,
      delays: [0],
    })
    await expect(recoverAfterBillingEvent({
      refresh: async () => snapshot({ allowed: true, reason: 'current_pool' }),
      resume: async () => true,
    })).resolves.toBe('idle')
    release()
    await expect(first).resolves.toBe('resumed')
  })

  it('is idle when no session armed the recovery', async () => {
    await expect(recoverAfterBillingEvent({
      refresh: async () => snapshot({ allowed: true, reason: 'current_pool' }),
      resume: async () => true,
    })).resolves.toBe('idle')
  })
})
