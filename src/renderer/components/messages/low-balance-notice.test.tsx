// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { LowBalanceNotice } from './low-balance-notice'

/**
 * The banner itself is trivial; what needs holding still is WHEN it appears.
 * It asks a workspace to top up, so every gate below is the difference between
 * a useful nudge and telling someone with no platform balance to pay for one.
 */

const platformAuth = {
  connected: true as boolean,
  platformBaseUrl: 'https://platform.example.com' as string | null,
  orgId: 'org_123' as string | null,
}
const settings = { llmProvider: 'platform' as string | null }
let billing: unknown = {
  connected: true,
  billing: {
    configured: true,
    subscription: { status: 'active', paymentStatus: null, currentPeriodEnd: null },
    seat: { balanceCents: 300, startingBalanceCents: 2000 },
    orgPool: { poolBalanceCents: 0 },
  },
}
let billingEnabled: boolean | undefined

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: settings }),
}))
vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: (enabled: boolean) => {
    billingEnabled = enabled
    return { data: enabled ? billing : undefined }
  },
}))
vi.mock('@renderer/lib/api-target', () => ({ getActiveTarget: () => 'local' }))

/** balanceCents for a given percent of a 2000-cent seat. */
const atPercent = (pct: number) => ({ balanceCents: (pct / 100) * 2000, startingBalanceCents: 2000 })

function setSeat(seat: { balanceCents: number; startingBalanceCents: number } | null) {
  billing = {
    connected: true,
    billing: {
      configured: true,
      subscription: { status: 'active', paymentStatus: null, currentPeriodEnd: null },
      seat,
      orgPool: { poolBalanceCents: 0 },
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  platformAuth.connected = true
  platformAuth.platformBaseUrl = 'https://platform.example.com'
  platformAuth.orgId = 'org_123'
  settings.llmProvider = 'platform'
  billingEnabled = undefined
  setSeat(atPercent(15))
})

const visible = () => screen.queryByTestId('low-balance-card') !== null

describe('LowBalanceNotice', () => {
  it('warns once the seat drops to the same point the Settings meter turns amber', () => {
    setSeat(atPercent(15))
    render(<LowBalanceNotice />)
    expect(visible()).toBe(true)
  })

  it('stays quiet while there is plenty left', () => {
    setSeat(atPercent(60))
    render(<LowBalanceNotice />)
    expect(visible()).toBe(false)
  })

  it('stays quiet at zero — the hard 402 is the accurate message there', () => {
    setSeat(atPercent(0))
    render(<LowBalanceNotice />)
    expect(visible()).toBe(false)
  })

  describe('does not ask for a top-up when there is no platform balance to top up', () => {
    it('BYOK provider', () => {
      settings.llmProvider = 'anthropic'
      render(<LowBalanceNotice />)
      expect(visible()).toBe(false)
      expect(billingEnabled).toBe(false)
    })

    it('platform account not connected', () => {
      platformAuth.connected = false
      render(<LowBalanceNotice />)
      expect(visible()).toBe(false)
      expect(billingEnabled).toBe(false)
    })

    it('org unknown', () => {
      platformAuth.orgId = null
      render(<LowBalanceNotice />)
      expect(visible()).toBe(false)
      expect(billingEnabled).toBe(false)
    })

    it('org has no seat', () => {
      setSeat(null)
      render(<LowBalanceNotice />)
      expect(visible()).toBe(false)
    })
  })

  it('links to the org billing page', () => {
    render(<LowBalanceNotice />)
    expect(screen.getByRole('button', { name: /go to billing/i })).toBeInTheDocument()
  })

  describe('dismissal', () => {
    it('stays gone for the band it was dismissed in', () => {
      const { unmount } = render(<LowBalanceNotice />)
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
      expect(visible()).toBe(false)

      unmount()
      render(<LowBalanceNotice />)
      expect(visible()).toBe(false)
    })

    it('comes back when the balance falls into the next band', () => {
      const { unmount } = render(<LowBalanceNotice />)
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
      unmount()

      // 15% was waved away; 3% is a more urgent statement, not the same one.
      setSeat(atPercent(3))
      render(<LowBalanceNotice />)
      expect(visible()).toBe(true)
    })

    it('does not re-warn about the milder band after the urgent one was dismissed', () => {
      setSeat(atPercent(3))
      const { unmount } = render(<LowBalanceNotice />)
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
      unmount()

      // A top-up that only reaches 15% should not re-raise what was just silenced.
      setSeat(atPercent(15))
      render(<LowBalanceNotice />)
      expect(visible()).toBe(false)
    })
  })
})
