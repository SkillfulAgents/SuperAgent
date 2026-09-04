// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'
import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'

import { PaywallCard } from './paywall-card'

const platformAuth = {
  connected: true,
  platformBaseUrl: 'https://platform.example.com',
  orgId: 'org_123',
  role: 'member' as string | null,
}
vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))

vi.mock('@renderer/components/home/home-empty-clouds', () => ({
  HomeEmptyClouds: () => null,
}))

const openExternalUrl = vi.fn()
vi.mock('@renderer/lib/open-external', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}))

const captureRendererException = vi.fn()
vi.mock('@renderer/lib/error-reporting', () => ({
  captureRendererException: (...args: unknown[]) => captureRendererException(...args),
}))

const fetchBilling = vi.fn<() => Promise<BillingInfoResponse>>()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async () => {
    const body = await fetchBilling()
    return { ok: true, json: async () => body }
  },
}))

const DENIED = { allowed: false, reason: 'insufficient_balance' }
const ALLOWED = { allowed: true, reason: 'current_pool' }

function billing(overrides: Partial<ParsedPlatformBillingInfo> = {}): BillingInfoResponse {
  return {
    connected: true,
    billing: {
      configured: true,
      subscription: { status: 'active', paymentStatus: 'current' },
      seat: { balanceCents: 0, startingBalanceCents: 2000 },
      orgPool: { poolBalanceCents: 0 },
      hasPaymentMethod: true,
      access: DENIED,
      ...overrides,
    } as ParsedPlatformBillingInfo,
  }
}

const MESSAGE = '**You need more usage credit to continue** Subscribe or top up.'
const PRESENTATION = {
  severity: 'error' as const,
  icon: 'circle-dollar-sign',
  message: MESSAGE,
  component: 'paywall',
  placement: 'composer' as const,
}

let client: QueryClient
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
function renderCard(
  message = 'API Error: 402 {"error":"insufficient_balance"}',
  live = true,
) {
  return render(
    <PaywallCard message={message} presentation={PRESENTATION} live={live}>
      <div data-testid="composer">composer</div>
    </PaywallCard>,
    { wrapper: Wrapper },
  )
}

// Focus is the in-card refresh signal (the deep link is handled app-wide).
const returnToWindow = () => act(() => { window.dispatchEvent(new Event('focus')) })

describe('PaywallCard', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    platformAuth.connected = true
    platformAuth.role = 'member'
    fetchBilling.mockResolvedValue(billing())
    window.electronAPI = { desktopProtocol: 'superagent' } as unknown as typeof window.electronAPI
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows a checking state, then routes members to ask an admin', async () => {
    renderCard()
    expect(screen.getByText('Checking billing')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Workspace billing needs attention')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Go to billing' })).toBeInTheDocument()
  })

  it('withholds the composer only once a fresh snapshot positively denies access', async () => {
    renderCard()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    await screen.findByText('Workspace billing needs attention')
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'true')
  })

  it('keeps the composer when the proxy snapshot carries no access verdict', async () => {
    fetchBilling.mockResolvedValue(billing({ access: undefined }))
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false')
  })

  it('keeps the composer when the denial is a stale cached fallback', async () => {
    fetchBilling.mockResolvedValue({ ...billing(), stale: true })
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('keeps the composer when the billing fetch fails, with the server copy and a billing link', async () => {
    fetchBilling.mockRejectedValue(new Error('boom'))
    renderCard()
    await waitFor(() => expect(captureRendererException).toHaveBeenCalled())
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to billing' })).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('keeps the composer when the platform is disconnected (billing query disabled)', async () => {
    platformAuth.connected = false
    renderCard()
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(fetchBilling).not.toHaveBeenCalled()
  })

  it('dismiss hands the composer back and removes the card, even while blocked', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: 'Dismiss' }).click() })
    expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('offers admins a top-up that hands off to the dashboard and back', async () => {
    platformAuth.role = 'owner'
    renderCard()
    const button = await screen.findByRole('button', { name: 'Add usage' })
    expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
    button.click()
    expect(openExternalUrl).toHaveBeenCalledTimes(1)
    const url = new URL(openExternalUrl.mock.calls[0][0])
    expect(url.pathname).toBe('/dashboard/organizations/org_123')
    expect(url.searchParams.get('tab')).toBe('billing')
    expect(url.searchParams.get('intent')).toBe('topup')
    expect(url.searchParams.get('return_app')).toBe('superagent://billing-updated')
  })

  it('asks admins to add a card first when the org has no payment method', async () => {
    platformAuth.role = 'admin'
    fetchBilling.mockResolvedValue(billing({ hasPaymentMethod: false }))
    renderCard()
    expect(await screen.findByRole('button', { name: 'Add credit card' })).toBeInTheDocument()
    expect(screen.getByText('Add a payment method')).toBeInTheDocument()
  })

  it('shows only the checking spinner while the snapshot is loading', () => {
    platformAuth.role = 'owner'
    fetchBilling.mockReturnValue(new Promise(() => {}))
    renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
    expect(screen.getByText('Checking billing')).toBeInTheDocument()
    expect(screen.getByTestId('paywall-actions-loading')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not clear a live 402 on an allowed snapshot cached before it appeared', async () => {
    client.setQueryData(['platform-billing'], billing({ access: ALLOWED }))
    fetchBilling.mockReturnValue(new Promise(() => {}))
    renderCard()
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('clears a persisted 402 from the current allowed snapshot (session switch after top-up)', async () => {
    client.setQueryData(['platform-billing'], billing({ access: ALLOWED }))
    fetchBilling.mockReturnValue(new Promise(() => {}))
    renderCard('API Error: 402 {"error":"insufficient_balance"}', false)
    await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('clears once a fresh snapshot says access is allowed again', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
    returnToWindow()
    await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('stays up (but unblocks) when the allowed snapshot is a stale cached fallback', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    fetchBilling.mockResolvedValue({ ...billing({ access: ALLOWED }), stale: true })
    returnToWindow()
    await waitFor(() => expect(fetchBilling).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('coalesces focus and visibility signals into one refetch', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    const before = fetchBilling.mock.calls.length
    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(fetchBilling.mock.calls.length).toBe(before + 1))
    await act(async () => {})
    expect(fetchBilling.mock.calls.length).toBe(before + 1)
  })
})
