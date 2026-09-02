import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getBillingResumeTarget,
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
  it('resumes only after a denied gate becomes allowed before expiry', () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z')
    expect(decideBillingResume(
      snapshot({ allowed: false, reason: 'insufficient_balance' }),
      target,
      now,
    )).toBe('wait')
    expect(decideBillingResume(
      snapshot({ allowed: true, reason: 'current_pool' }),
      target,
      now,
    )).toBe('resume')
    expect(decideBillingResume(snapshot(), target, now)).toBe('abort')
    expect(decideBillingResume(
      snapshot({ allowed: true, reason: 'current_pool' }),
      { ...target, initialAllowed: true },
      now,
    )).toBe('abort')
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

  it('does not resume from a stale allowed snapshot', async () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    const staleAllowed = { ...snapshot({ allowed: true, reason: 'current_pool' }), stale: true }
    const resume = vi.fn().mockResolvedValue(true)

    await expect(recoverAfterBillingEvent({
      refresh: vi.fn()
        .mockResolvedValueOnce(staleAllowed)
        .mockResolvedValueOnce(snapshot({ allowed: true, reason: 'current_pool' })),
      resume,
      sleep: async () => {},
      delays: [0, 0],
    })).resolves.toBe('resumed')

    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('clears a terminal target when access is unavailable', async () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })

    await expect(recoverAfterBillingEvent({
      refresh: async () => snapshot(),
      resume: vi.fn(),
      delays: [0],
    })).resolves.toBe('aborted')

    expect(getBillingResumeTarget()).toBeNull()
  })
})
