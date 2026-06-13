// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, fireEvent } from '@testing-library/react'

import { InsufficientBalanceCard, usePlatformBillingUrl } from './insufficient-balance-card'

const platformAuth = {
  connected: true as boolean,
  platformBaseUrl: 'https://platform.example.com' as string | null,
  orgId: 'org_123' as string | null,
}
const settings = { llmProvider: 'platform' as string | null }

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: settings }),
}))

const BILLING_MESSAGE = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'

beforeEach(() => {
  platformAuth.connected = true
  platformAuth.platformBaseUrl = 'https://platform.example.com'
  platformAuth.orgId = 'org_123'
  settings.llmProvider = 'platform'
})

describe('usePlatformBillingUrl', () => {
  it('returns the org billing URL for a platform insufficient-balance error', () => {
    const { result } = renderHook(() => usePlatformBillingUrl(BILLING_MESSAGE))
    expect(result.current).toBe(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
  })

  it('returns null when the error is not insufficient-balance', () => {
    const { result } = renderHook(() => usePlatformBillingUrl('API Error: 500 server error'))
    expect(result.current).toBeNull()
  })

  it('returns null for a BYOK provider (llmProvider is not platform)', () => {
    settings.llmProvider = 'anthropic'
    const { result } = renderHook(() => usePlatformBillingUrl(BILLING_MESSAGE))
    expect(result.current).toBeNull()
  })

  it('returns null when the platform account is not connected', () => {
    platformAuth.connected = false
    const { result } = renderHook(() => usePlatformBillingUrl(BILLING_MESSAGE))
    expect(result.current).toBeNull()
  })

  it('returns null when orgId is missing', () => {
    platformAuth.orgId = null
    const { result } = renderHook(() => usePlatformBillingUrl(BILLING_MESSAGE))
    expect(result.current).toBeNull()
  })
})

describe('InsufficientBalanceCard', () => {
  it('renders the actionable card and opens billing externally on click', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { openExternal }

    render(<InsufficientBalanceCard billingUrl="https://platform.example.com/billing" />)

    expect(screen.getByText('Insufficient balance')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /go to billing/i })
    fireEvent.click(button)
    expect(openExternal).toHaveBeenCalledWith('https://platform.example.com/billing')
  })
})
