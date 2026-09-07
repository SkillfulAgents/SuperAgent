// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'
import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'

import { PlatformPaywallCard } from './platform-paywall-card'
import { PAYWALL_RECHECK_INTERVAL_MS } from './use-platform-paywall-billing'

const platformAuth = {
  connected: true,
  orgId: 'org_123' as string | null,
  role: 'member' as string | null,
  platformControlled: undefined as boolean | undefined,
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
const fetchEmbed = vi.fn<(init?: RequestInit) => Promise<{ ok: boolean; body: unknown }>>()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    if (path === '/api/platform-auth/billing-embed') {
      const res = await fetchEmbed(init)
      return { ok: res.ok, json: async () => res.body }
    }
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
const BILLING_URL = 'https://platform.example.com/dashboard/organizations/org_123?tab=billing'
const PRESENTATION: ProviderErrorPresentation = {
  severity: 'error',
  icon: 'circle-dollar-sign',
  message: MESSAGE,
  component: 'platform-paywall',
  placement: 'composer',
  href: BILLING_URL,
}

const PLATFORM_ORIGIN = 'https://platform.example.com'
const EMBED_SESSION = {
  embedUrl: `${PLATFORM_ORIGIN}/embed/session?token_hash=abc&org_id=org_123`,
  platformOrigin: PLATFORM_ORIGIN,
}

function postEmbedMessage(origin: string, event: string, extra: Record<string, unknown> = {}) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'gamut-billing-embed', orgId: 'org_123', event, ...extra },
      }),
    )
  })
}

let client: QueryClient
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
function renderCard(
  message = 'API Error: 402 {"error":"insufficient_balance"}',
  live = true,
  presentation = PRESENTATION,
) {
  return render(
    <PlatformPaywallCard message={message} presentation={presentation} live={live}>
      <div data-testid="composer">composer</div>
    </PlatformPaywallCard>,
    { wrapper: Wrapper },
  )
}

function clickRecheck(ctaName: string) {
  act(() => { screen.getByRole('button', { name: ctaName }).click() })
  act(() => { screen.getByRole('button', { name: 'Recheck' }).click() })
}

describe('PlatformPaywallCard', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    platformAuth.connected = true
    platformAuth.role = 'member'
    platformAuth.platformControlled = undefined
    fetchBilling.mockResolvedValue(billing())
    fetchEmbed.mockResolvedValue({ ok: true, body: EMBED_SESSION })
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete (window as { electronAPI?: unknown }).electronAPI
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

  it('opens the platform on Add usage, then that button becomes Recheck', async () => {
    platformAuth.role = 'owner'
    renderCard()
    const button = await screen.findByRole('button', { name: 'Add usage' })
    expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
    act(() => { button.click() })
    expect(openExternalUrl).toHaveBeenCalledTimes(1)
    const url = new URL(openExternalUrl.mock.calls[0][0])
    expect(url.pathname).toBe('/dashboard/organizations/org_123')
    expect(url.searchParams.get('tab')).toBe('billing')
    expect(url.searchParams.get('intent')).toBe('topup')
    expect(url.searchParams.has('return_app')).toBe(false)
    const recheck = screen.getByRole('button', { name: 'Recheck' })
    expect(screen.queryByRole('button', { name: 'Add usage' })).not.toBeInTheDocument()
    fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
    act(() => { recheck.click() })
    await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('disables the CTA when the provider attached no href', async () => {
    platformAuth.role = 'owner'
    renderCard(undefined, true, { ...PRESENTATION, href: undefined })
    const button = await screen.findByRole('button', { name: 'Add usage' })
    expect(button).toBeDisabled()
    act(() => { button.click() })
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('rechecks automatically every 5s while a fresh snapshot denies access', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      renderCard()
      await screen.findByText('Workspace billing needs attention')
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAYWALL_RECHECK_INTERVAL_MS)
      })
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(screen.getByTestId('composer')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll when the snapshot carries no access verdict (nothing can flip)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      fetchBilling.mockResolvedValue(billing({ access: undefined }))
      renderCard()
      await screen.findByText('Workspace billing needs attention')
      const before = fetchBilling.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAYWALL_RECHECK_INTERVAL_MS * 3)
      })
      expect(fetchBilling.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses the poll while the document is hidden and resumes when it is visible again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    try {
      renderCard()
      await screen.findByText('Workspace billing needs attention')
      visibility = 'hidden'
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      const before = fetchBilling.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAYWALL_RECHECK_INTERVAL_MS * 3)
      })
      expect(fetchBilling.mock.calls.length).toBe(before)

      visibility = 'visible'
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      // Becoming visible refetches once on return (50ms coalesce, real timer); the poll then
      // resumes on top of that. waitFor is avoided: its polling uses the faked setInterval.
      await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
      expect(fetchBilling.mock.calls.length).toBe(before + 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAYWALL_RECHECK_INTERVAL_MS)
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      expect(fetchBilling.mock.calls.length).toBe(before + 2)
    } finally {
      vi.useRealTimers()
      delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  it('refetches once on window focus, coalesced with the visibility signal', async () => {
    fetchBilling.mockResolvedValue(billing({ access: undefined }))
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

  it('stops listening for refresh signals once dismissed', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    act(() => { screen.getByRole('button', { name: 'Dismiss' }).click() })
    const before = fetchBilling.mock.calls.length
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    expect(fetchBilling.mock.calls.length).toBe(before)
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
    clickRecheck('Go to billing')
    await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('stays up (but unblocks) when the allowed snapshot is a stale cached fallback', async () => {
    renderCard()
    await screen.findByText('Workspace billing needs attention')
    const before = fetchBilling.mock.calls.length
    fetchBilling.mockResolvedValue({ ...billing({ access: ALLOWED }), stale: true })
    clickRecheck('Go to billing')
    await waitFor(() => expect(fetchBilling.mock.calls.length).toBeGreaterThan(before))
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  describe('web on a cloud workspace (in-app billing)', () => {
    beforeEach(() => {
      platformAuth.role = 'owner'
      platformAuth.platformControlled = true
    })

    it('renders the platform billing page inline in place of the CTA button', async () => {
      renderCard()
      const frame = await screen.findByTestId('billing-embed-frame')
      expect(frame).toHaveAttribute('src', EMBED_SESSION.embedUrl)
      expect(JSON.parse(String(fetchEmbed.mock.calls[0][0]?.body))).toEqual({ intent: 'topup', view: 'topup' })
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-embedded', 'true')
      expect(screen.queryByRole('button', { name: 'Add usage' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
      expect(openExternalUrl).not.toHaveBeenCalled()
    })

    it('hides the loading overlay once the platform page reports ready', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      expect(screen.getByTestId('billing-embed-loading')).toBeInTheDocument()
      postEmbedMessage(PLATFORM_ORIGIN, 'ready')
      expect(screen.queryByTestId('billing-embed-loading')).not.toBeInTheDocument()
    })

    it('sizes the frame from the platform resize event, clamped', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      const body = screen.getByTestId('billing-embed-body')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 312.4 })
      expect(body.style.height).toBe('313px')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 5000 })
      expect(body.style.height).toBe('640px')
      postEmbedMessage('https://evil.example', 'resize', { height: 200 })
      expect(body.style.height).toBe('640px')
    })

    it('rechecks billing on billing-updated from the platform origin and clears the card', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(screen.getByTestId('composer')).toBeInTheDocument()
    })

    it('ignores billing-updated from any other origin', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      const before = fetchBilling.mock.calls.length
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage('https://evil.example', 'billing-updated')
      await act(async () => {})
      expect(fetchBilling.mock.calls.length).toBe(before)
      expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    })

    it('ignores messages about another org even from the platform origin', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      const before = fetchBilling.mock.calls.length
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { orgId: 'org_other' })
      postEmbedMessage(PLATFORM_ORIGIN, 'ready', { orgId: 'org_other' })
      await act(async () => {})
      expect(fetchBilling.mock.calls.length).toBe(before)
      expect(screen.getByTestId('billing-embed-loading')).toBeInTheDocument()
    })

    it('remounts the frame with the panel that matches the CTA after a recheck flips it', async () => {
      fetchBilling.mockResolvedValue(billing({ subscription: { status: 'active', paymentStatus: 'past_due', currentPeriodEnd: null } }))
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      expect(JSON.parse(String(fetchEmbed.mock.calls[0][0]?.body))).toEqual({ view: 'payment' })

      fetchBilling.mockResolvedValue(billing())
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(fetchEmbed).toHaveBeenCalledTimes(2))
      expect(JSON.parse(String(fetchEmbed.mock.calls[1][0]?.body))).toEqual({ intent: 'topup', view: 'topup' })
      expect(screen.getByText('Add usage credit to resume this answer.')).toBeInTheDocument()
    })

    it('falls back to opening billing externally when the embed session cannot be minted, then offers a recheck', async () => {
      fetchEmbed.mockResolvedValue({ ok: false, body: { error: 'Only admins.', code: 'forbidden' } })
      renderCard()
      const fallback = await screen.findByRole('button', { name: 'Open billing in a new tab' })
      expect(screen.getByText('Only admins.')).toBeInTheDocument()
      act(() => { fallback.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(new URL(openExternalUrl.mock.calls[0][0]).searchParams.get('intent')).toBe('topup')
      expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument()
    })

    it('falls back when the host returns a malformed embed session', async () => {
      fetchEmbed.mockResolvedValue({ ok: true, body: { embedUrl: 'not a url' } })
      renderCard()
      await screen.findByRole('button', { name: 'Open billing in a new tab' })
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
    })

    it('offers the external link when the platform reports the session expired', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'session-expired')
      expect(screen.getByText('This billing session has expired.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open billing in a new tab' })).toBeInTheDocument()
    })

    it('"Try again" mints a fresh session after the previous one expired', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'session-expired')
      const second = { ...EMBED_SESSION, embedUrl: `${PLATFORM_ORIGIN}/embed/session?token_hash=def&org_id=org_123` }
      fetchEmbed.mockResolvedValue({ ok: true, body: second })
      act(() => { screen.getByRole('button', { name: 'Try again' }).click() })
      const frame = await screen.findByTestId('billing-embed-frame')
      expect(frame).toHaveAttribute('src', second.embedUrl)
      expect(fetchEmbed).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId('billing-embed-loading')).toBeInTheDocument()
    })

    it('dismiss removes the inline billing page and hands the composer back', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      act(() => { screen.getByRole('button', { name: 'Dismiss' }).click() })
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
      expect(screen.getByTestId('composer')).toBeInTheDocument()
    })

    it('embeds the same top-up panel when the org has no card yet (it offers add-card)', async () => {
      fetchBilling.mockResolvedValue(billing({ hasPaymentMethod: false }))
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      expect(JSON.parse(String(fetchEmbed.mock.calls[0][0]?.body))).toEqual({ view: 'topup' })
      expect(screen.queryByRole('button', { name: 'Add credit card' })).not.toBeInTheDocument()
    })

    it('embeds the subscribe panel when a subscription is required', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-embed-frame')
      expect(JSON.parse(String(fetchEmbed.mock.calls[0][0]?.body))).toEqual({ view: 'subscribe' })
      expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()
    })

    it('embeds the payment panel when the payment is past due', async () => {
      fetchBilling.mockResolvedValue(billing({ subscription: { status: 'active', paymentStatus: 'past_due', currentPeriodEnd: null } }))
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      expect(JSON.parse(String(fetchEmbed.mock.calls[0][0]?.body))).toEqual({ view: 'payment' })
      expect(screen.queryByRole('button', { name: 'Fix payment' })).not.toBeInTheDocument()
    })

    it('still sends members to the browser (the embed would only show them no access)', async () => {
      platformAuth.role = 'member'
      renderCard()
      const button = await screen.findByRole('button', { name: 'Go to billing' })
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(fetchEmbed).not.toHaveBeenCalled()
    })

    it('keeps the system-browser hand-off in Electron even on a cloud workspace', async () => {
      ;(window as { electronAPI?: unknown }).electronAPI = {}
      renderCard()
      const button = await screen.findByRole('button', { name: 'Add usage' })
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(fetchEmbed).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument()
    })

    it('keeps the system-browser hand-off on web when the workspace is not platform-controlled', async () => {
      platformAuth.platformControlled = false
      renderCard()
      const button = await screen.findByRole('button', { name: 'Add usage' })
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(fetchEmbed).not.toHaveBeenCalled()
    })
  })
})
