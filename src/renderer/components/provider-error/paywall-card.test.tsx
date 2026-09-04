// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'
import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'

import {
  buildTopupHandoffUrl,
  isPlatformOrgAdmin,
  PaywallCard,
  resolveOrgBillingUrl,
  resolvePaywallCta,
  subscriptionRequiredFromBilling,
} from './paywall-card'

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

function billing(overrides: Partial<ParsedPlatformBillingInfo> = {}): BillingInfoResponse {
  return {
    connected: true,
    billing: {
      configured: true,
      subscription: { status: 'active', paymentStatus: 'current' },
      seat: { balanceCents: 0, startingBalanceCents: 2000 },
      orgPool: { poolBalanceCents: 0 },
      hasPaymentMethod: true,
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

describe('PaywallCard', () => {
  let billingUpdated: (() => void) | undefined

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    platformAuth.role = 'member'
    fetchBilling.mockResolvedValue(billing())
    billingUpdated = undefined
    window.electronAPI = {
      desktopProtocol: 'superagent',
      onBillingUpdated: (cb: () => void) => {
        billingUpdated = cb
        return () => {}
      },
      flushPendingBillingUpdated: async () => false,
    } as unknown as typeof window.electronAPI
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

  it('withholds the displaced composer while the paywall is up', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
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

  it('resolves subscribe from the 402 body before the snapshot arrives', () => {
    platformAuth.role = 'owner'
    fetchBilling.mockReturnValue(new Promise(() => {}))
    renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
    expect(screen.getByText('Checking billing')).toBeInTheDocument()
    expect(screen.getByTestId('paywall-actions-loading')).toBeInTheDocument()
  })

  it('does not clear a live 402 on a snapshot cached before it appeared', async () => {
    client.setQueryData(['platform-billing'], billing({ access: { allowed: true, reason: 'ok' } }))
    fetchBilling.mockReturnValue(new Promise(() => {}))
    renderCard()
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
  })

  it('clears a persisted 402 from the current allowed snapshot (session switch after top-up)', async () => {
    client.setQueryData(['platform-billing'], billing({ access: { allowed: true, reason: 'ok' } }))
    fetchBilling.mockReturnValue(new Promise(() => {}))
    renderCard('API Error: 402 {"error":"insufficient_balance"}', false)
    await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('hands the composer back once a fresh snapshot says access is allowed again', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    fetchBilling.mockResolvedValue(billing({ access: { allowed: true, reason: 'ok' } }))
    act(() => billingUpdated?.())
    await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('stays up when the allowed snapshot is a stale cached fallback', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    fetchBilling.mockResolvedValue({ ...billing({ access: { allowed: true, reason: 'ok' } }), stale: true })
    act(() => billingUpdated?.())
    await waitFor(() => expect(fetchBilling).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
  })

  it('coalesces the deep link, focus and visibility signals into one refetch', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    const before = fetchBilling.mock.calls.length
    act(() => {
      billingUpdated?.()
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(fetchBilling.mock.calls.length).toBe(before + 1))
    await act(async () => {})
    expect(fetchBilling.mock.calls.length).toBe(before + 1)
  })

  it('reports a failed billing fetch and falls back to the server copy plus a billing link', async () => {
    fetchBilling.mockRejectedValue(new Error('boom'))
    renderCard()
    await waitFor(() => expect(captureRendererException).toHaveBeenCalled())
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to billing' })).toBeInTheDocument()
  })
})

const HREF = 'https://platform.example.com/dashboard/organizations/org_123?tab=billing'

describe('isPlatformOrgAdmin', () => {
  it('is true for owner and admin', () => {
    expect(isPlatformOrgAdmin('owner')).toBe(true)
    expect(isPlatformOrgAdmin('admin')).toBe(true)
  })

  it('is false for member and missing role', () => {
    expect(isPlatformOrgAdmin('member')).toBe(false)
    expect(isPlatformOrgAdmin(null)).toBe(false)
    expect(isPlatformOrgAdmin(undefined)).toBe(false)
  })
})

describe('resolveOrgBillingUrl', () => {
  it('builds the billing URL from a connected org', () => {
    expect(resolveOrgBillingUrl({
      connected: true,
      platformBaseUrl: 'https://platform.example.com',
      orgId: 'org_123',
    })).toBe(HREF)
  })

  it('strips a trailing slash from the platform base URL', () => {
    expect(resolveOrgBillingUrl({
      connected: true,
      platformBaseUrl: 'https://platform.example.com/',
      orgId: 'org_123',
    })).toBe(HREF)
  })

  it('returns null when disconnected or org context is missing', () => {
    expect(resolveOrgBillingUrl(null)).toBeNull()
    expect(resolveOrgBillingUrl({ connected: false, platformBaseUrl: 'https://p.example.com', orgId: 'org_123' })).toBeNull()
    expect(resolveOrgBillingUrl({ connected: true, platformBaseUrl: null, orgId: 'org_123' })).toBeNull()
    expect(resolveOrgBillingUrl({ connected: true, platformBaseUrl: 'https://p.example.com', orgId: null })).toBeNull()
  })
})

describe('buildTopupHandoffUrl', () => {
  it('appends the intent and the return deep link', () => {
    expect(buildTopupHandoffUrl(HREF, 'superagent')).toBe(
      `${HREF}&intent=topup&return_app=superagent%3A%2F%2Fbilling-updated`,
    )
  })

  it('uses the dev scheme when the app runs unpackaged', () => {
    expect(buildTopupHandoffUrl(HREF, 'superagent-dev')).toContain(
      'return_app=superagent-dev%3A%2F%2Fbilling-updated',
    )
  })

  it('omits return_app when the protocol scheme is unknown', () => {
    const url = buildTopupHandoffUrl(HREF, undefined)
    expect(url).toContain('intent=topup')
    expect(url).not.toContain('return_app')
  })

  it('returns null for a missing or unparseable billing href', () => {
    expect(buildTopupHandoffUrl(null, 'superagent')).toBeNull()
    expect(buildTopupHandoffUrl('not a url', 'superagent')).toBeNull()
  })
})

describe('subscriptionRequiredFromBilling', () => {
  it('treats a live plan as subscribed and a canceled or unset plan as required', () => {
    expect(subscriptionRequiredFromBilling({ configured: false, subscription: { status: null } })).toBe(true)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'canceled' } })).toBe(true)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'active' } })).toBe(false)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'cancellation_scheduled' } })).toBe(false)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'past_due' } })).toBeUndefined()
    expect(subscriptionRequiredFromBilling(undefined)).toBeUndefined()
  })
})

describe('resolvePaywallCta', () => {
  it('falls back to a billing button when the proxy omitted the flag', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: undefined,
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'go_to_billing', href: HREF })
  })

  it('returns subscribe when an admin needs a plan', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: true,
      role: 'owner',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'subscribe', href: HREF })
  })

  it('asks an admin for every write action, including subscribe', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: true,
      role: 'member',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'ask_admin', href: HREF })
  })

  it('shows a billing button, not ask-admin, when the role is unknown', () => {
    for (const role of [null, undefined]) {
      expect(resolvePaywallCta({
        subscriptionRequired: false,
        role,
        hasPaymentMethod: undefined,
        billingHref: HREF,
      })).toEqual({ kind: 'go_to_billing', href: HREF })
    }
  })

  it('asks an admin to top up when the member cannot bill', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'member',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'ask_admin', href: HREF })
  })

  it('asks for a card when the admin has no payment method yet', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'admin',
      hasPaymentMethod: false,
      billingHref: HREF,
    })).toEqual({ kind: 'add_card', href: HREF })
  })

  it('does not guess add-card when the payment method is unknown', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'admin',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'go_to_billing', href: HREF })
  })

  it('treats a scheduled cancellation as a usage-credit path', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: subscriptionRequiredFromBilling({
        configured: true,
        subscription: { status: 'cancellation_scheduled' },
      }),
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'topup', href: HREF })
  })

  it('returns the top-up CTA when the admin already has a card', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'topup', href: HREF })
  })

  it('prioritizes fixing a failed payment for an admin', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'owner',
      hasPaymentMethod: true,
      paymentStatus: 'past_due',
      billingHref: HREF,
    })).toEqual({ kind: 'manage_payment', href: HREF })
  })
})
