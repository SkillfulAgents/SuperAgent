// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'
import type { BillingInfoResponse } from '@renderer/hooks/use-billing-info'

import { FRAME_READY_TIMEOUT_MS } from './billing-embed-frame'
import { PlatformPaywallCard } from './platform-paywall-card'
import { PAYWALL_RECHECK_INTERVAL_MS } from './use-platform-paywall-billing'

const PLATFORM_ORIGIN = 'https://platform.example.com'
const HOSTILE_ORIGIN = 'https://evil.example.com'
const PLATFORM_BASE_URL = `${PLATFORM_ORIGIN}/`

const platformAuth = {
  connected: true,
  orgId: 'org_123' as string | null,
  role: 'member' as string | null,
  platformControlled: undefined as boolean | undefined,
  platformBaseUrl: PLATFORM_BASE_URL as string | null,
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
const BILLING_URL = 'https://platform.example.com/dashboard/organizations/org_123?tab=billing'
const PRESENTATION: ProviderErrorPresentation = {
  severity: 'error',
  icon: 'circle-dollar-sign',
  message: MESSAGE,
  component: 'platform-paywall',
  placement: 'composer',
  href: BILLING_URL,
}

function embedFrame(): HTMLIFrameElement {
  return screen.getByTestId('billing-embed-frame') as HTMLIFrameElement
}

function embedSrc(): URL {
  return new URL(embedFrame().src)
}

function frameWindow(): Window {
  const frame = embedFrame()
  if (frame.contentWindow) return frame.contentWindow
  const fake = { name: 'billing-embed-frame' } as unknown as Window
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: fake })
  return fake
}

function postEmbedMessage(
  origin: string,
  event: string,
  extra: Record<string, unknown> = {},
  source?: MessageEventSource | null,
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source: source === undefined ? frameWindow() : source,
        data: { type: 'gamut-billing-embed', orgId: 'org_123', event, ...extra },
      }),
    )
  })
}

function expectEmbedUrl(expected: { view: string; intent?: string }) {
  const url = embedSrc()
  expect(url.origin).toBe(PLATFORM_ORIGIN)
  expect(url.pathname).toBe('/embed/billing/org_123')
  expect(url.searchParams.get('parent')).toBe(window.location.origin)
  expect(url.searchParams.get('view')).toBe(expected.view)
  expect(url.searchParams.get('intent')).toBe(expected.intent ?? null)
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
    platformAuth.orgId = 'org_123'
    platformAuth.role = 'member'
    platformAuth.platformControlled = undefined
    platformAuth.platformBaseUrl = PLATFORM_BASE_URL
    fetchBilling.mockResolvedValue(billing())
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
    await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  describe('web on a cloud workspace (in-app billing)', () => {
    beforeEach(() => {
      platformAuth.role = 'owner'
      platformAuth.platformControlled = true
    })

    it('renders the platform billing page inline, in place of the CTA button', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      expectEmbedUrl({ view: 'topup', intent: 'topup' })
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

    it('keeps the iframe visible under the loading overlay so a Storage Access prompt can be used', async () => {
      renderCard()
      const frame = await screen.findByTestId('billing-embed-frame')
      const overlay = screen.getByTestId('billing-embed-loading')
      expect(overlay).toBeInTheDocument()
      expect(frame).toBeVisible()
      expect(overlay.className).toContain('pointer-events-none')
    })

    it('sizes the frame from the platform resize event, clamped', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      const body = screen.getByTestId('billing-embed-body')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 312.4 })
      expect(body.style.height).toBe('313px')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 5000 })
      expect(body.style.height).toBe('640px')
      postEmbedMessage(window.location.origin, 'resize', { height: 200 })
      expect(body.style.height).toBe('640px')
    })

    it('rechecks billing on billing-updated from the frame and clears the card', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(screen.getByTestId('composer')).toBeInTheDocument()
    })

    it('ignores billing-updated from a hostile origin even when the source is the iframe', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      const before = fetchBilling.mock.calls.length
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(HOSTILE_ORIGIN, 'billing-updated')
      await act(async () => {})
      expect(fetchBilling.mock.calls.length).toBe(before)
      expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    })

    it('ignores a matching-origin message whose source is not the iframe', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      const before = fetchBilling.mock.calls.length
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', {}, window)
      postEmbedMessage(PLATFORM_ORIGIN, 'ready', {}, window)
      await act(async () => {})
      expect(fetchBilling.mock.calls.length).toBe(before)
      expect(screen.getByTestId('billing-embed-loading')).toBeInTheDocument()
    })

    it('ignores messages about another org even from the platform iframe', async () => {
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
      expectEmbedUrl({ view: 'payment' })

      fetchBilling.mockResolvedValue(billing())
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expectEmbedUrl({ view: 'topup', intent: 'topup' }))
      expect(screen.getByText('Add usage credit to resume this answer.')).toBeInTheDocument()
    })

    it('falls back to opening billing externally when the workspace has no org id, then offers a recheck', async () => {
      platformAuth.orgId = null
      renderCard()
      const fallback = await screen.findByRole('button', { name: 'Open billing in a new tab' })
      expect(screen.getByText('Could not open billing.')).toBeInTheDocument()
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
      act(() => { fallback.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(new URL(openExternalUrl.mock.calls[0][0]).searchParams.get('intent')).toBe('topup')
      expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument()
    })

    it('falls back when platform base URL is missing', async () => {
      platformAuth.platformBaseUrl = null
      renderCard()
      expect(await screen.findByText('Could not open billing.')).toBeInTheDocument()
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open billing in a new tab' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    })

    it('falls back when platform base URL is not a valid origin', async () => {
      platformAuth.platformBaseUrl = 'not-a-url'
      renderCard()
      expect(await screen.findByText('Could not open billing.')).toBeInTheDocument()
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
    })

    it('falls back when the platform page never reports ready', async () => {
      // Faking timers stalls react-query; fire the ready timeout's callback directly instead.
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
      try {
        renderCard()
        await screen.findByTestId('billing-embed-frame')
        const readyTimer = setTimeoutSpy.mock.calls.find(([, delay]) => delay === FRAME_READY_TIMEOUT_MS)
        expect(readyTimer).toBeDefined()
        act(() => { (readyTimer![0] as () => void)() })
        expect(screen.getByText('Billing is taking too long to load.')).toBeInTheDocument()
        expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Open billing in a new tab' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('"Try again" after a ready timeout remounts the frame and restarts the timeout', async () => {
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
      try {
        renderCard()
        await screen.findByTestId('billing-embed-frame')
        const firstTimer = setTimeoutSpy.mock.calls.find(([, delay]) => delay === FRAME_READY_TIMEOUT_MS)
        expect(firstTimer).toBeDefined()
        act(() => { (firstTimer![0] as () => void)() })
        const beforeRetry = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === FRAME_READY_TIMEOUT_MS).length
        act(() => { screen.getByRole('button', { name: 'Try again' }).click() })
        const second = await screen.findByTestId('billing-embed-frame')
        expectEmbedUrl({ view: 'topup', intent: 'topup' })
        expect(screen.getByTestId('billing-embed-loading')).toBeInTheDocument()
        const retryTimers = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === FRAME_READY_TIMEOUT_MS)
        expect(retryTimers.length).toBeGreaterThan(beforeRetry)
        act(() => { (retryTimers.at(-1)![0] as () => void)() })
        expect(screen.getByText('Billing is taking too long to load.')).toBeInTheDocument()
        expect(second).not.toBeInTheDocument()
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('offers the external link when the platform reports the session expired', async () => {
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'session-expired')
      expect(screen.getByText('This billing session has expired.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open billing in a new tab' })).toBeInTheDocument()
    })

    it('"Try again" reloads the frame after the platform reported the session expired', async () => {
      renderCard()
      const first = await screen.findByTestId('billing-embed-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'ready')
      postEmbedMessage(PLATFORM_ORIGIN, 'session-expired')
      act(() => { screen.getByRole('button', { name: 'Try again' }).click() })
      const second = await screen.findByTestId('billing-embed-frame')
      expect(second).not.toBe(first)
      expectEmbedUrl({ view: 'topup', intent: 'topup' })
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
      expectEmbedUrl({ view: 'topup' })
      expect(screen.queryByRole('button', { name: 'Add credit card' })).not.toBeInTheDocument()
    })

    it('embeds the subscribe panel when a subscription is required', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-embed-frame')
      expectEmbedUrl({ view: 'subscribe' })
      expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()
    })

    it('embeds the payment panel when the payment is past due', async () => {
      fetchBilling.mockResolvedValue(billing({ subscription: { status: 'active', paymentStatus: 'past_due', currentPeriodEnd: null } }))
      renderCard()
      await screen.findByTestId('billing-embed-frame')
      expectEmbedUrl({ view: 'payment' })
      expect(screen.queryByRole('button', { name: 'Fix payment' })).not.toBeInTheDocument()
    })

    it('still sends members to the browser (the embed would only show them no access)', async () => {
      platformAuth.role = 'member'
      renderCard()
      const button = await screen.findByRole('button', { name: 'Go to billing' })
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
    })

    it('keeps the system-browser hand-off in Electron even on a cloud workspace', async () => {
      ;(window as { electronAPI?: unknown }).electronAPI = {}
      renderCard()
      const button = await screen.findByRole('button', { name: 'Add usage' })
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument()
    })

    it('keeps the system-browser hand-off on web when the workspace is not platform-controlled', async () => {
      platformAuth.platformControlled = false
      renderCard()
      const button = await screen.findByRole('button', { name: 'Add usage' })
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
    })
  })
})
