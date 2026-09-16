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

const mocks = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mocks.track }),
}))

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

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (message: string) => toastSuccess(message) } }))

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

function embedFrame(testId: 'billing-cta-frame' | 'billing-embed-frame' = 'billing-cta-frame'): HTMLIFrameElement {
  return screen.getByTestId(testId) as HTMLIFrameElement
}

function embedSrc(testId: 'billing-cta-frame' | 'billing-embed-frame' = 'billing-cta-frame'): URL {
  return new URL(embedFrame(testId).src)
}

function frameWindow(testId: 'billing-cta-frame' | 'billing-embed-frame' = 'billing-cta-frame'): Window {
  const frame = embedFrame(testId)
  if (frame.contentWindow) return frame.contentWindow
  const fake = { name: testId } as unknown as Window
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: fake })
  return fake
}

function postEmbedMessage(
  origin: string,
  event: string,
  extra: Record<string, unknown> = {},
  source?: MessageEventSource | null,
  testId: 'billing-cta-frame' | 'billing-embed-frame' = 'billing-cta-frame',
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source: source === undefined ? frameWindow(testId) : source,
        data: { type: 'gamut-billing-embed', orgId: 'org_123', event, ...extra },
      }),
    )
  })
}

function expectEmbedUrl(
  expected: { view: string; intent?: string; surface?: string; cta?: string },
  testId: 'billing-cta-frame' | 'billing-embed-frame' = 'billing-cta-frame',
) {
  const url = embedSrc(testId)
  expect(url.origin).toBe(PLATFORM_ORIGIN)
  expect(url.pathname).toBe('/embed/billing/org_123')
  expect(url.searchParams.get('parent')).toBe(window.location.origin)
  expect(url.searchParams.get('view')).toBe(expected.view)
  expect(url.searchParams.get('intent')).toBe(expected.intent ?? null)
  expect(url.searchParams.get('surface')).toBe(expected.surface ?? null)
  expect(url.searchParams.get('cta')).toBe(expected.cta ?? null)
}

async function expandCta() {
  const frame = await screen.findByTestId('billing-cta-frame')
  postEmbedMessage(PLATFORM_ORIGIN, 'open-billing')
  await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true'))
  return frame
}

let client: QueryClient
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
function renderCard(
  message = 'API Error: 402 {"error":"insufficient_balance"}',
  live = true,
  presentation = PRESENTATION,
  dismissible = false,
) {
  return render(
    <PlatformPaywallCard message={message} presentation={presentation} live={live} dismissible={dismissible}>
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

  it('tracks the paywall being shown and its CTA click', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByText('Workspace billing needs attention')).toBeInTheDocument())
    expect(mocks.track).toHaveBeenCalledWith('paywall_shown', { ctaKind: 'ask_admin', blocked: true, placement: 'composer' })
    expect(mocks.track).toHaveBeenCalledTimes(1)
    act(() => { screen.getByRole('button', { name: 'Go to billing' }).click() })
    expect(mocks.track).toHaveBeenCalledWith('paywall_cta_clicked', { ctaKind: 'ask_admin' })
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
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

  it('shows Dismiss when dismissible and hands the composer back while blocked', async () => {
    renderCard(undefined, true, PRESENTATION, true)
    await screen.findByText('Workspace billing needs attention')
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    act(() => { screen.getByRole('button', { name: 'Dismiss' }).click() })
    expect(mocks.track).toHaveBeenCalledWith('paywall_dismissed', { ctaKind: 'ask_admin', handedOff: false })
    expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })

  it('stops listening for refresh signals once dismissed', async () => {
    renderCard(undefined, true, PRESENTATION, true)
    await screen.findByText('Workspace billing needs attention')
    act(() => { screen.getByRole('button', { name: 'Dismiss' }).click() })
    const before = fetchBilling.mock.calls.length
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    expect(fetchBilling.mock.calls.length).toBe(before)
  })

  it('keeps the composer when the platform is disconnected (billing query disabled)', async () => {
    platformAuth.connected = false
    renderCard()
    await act(async () => {})
    expect(screen.getByTestId('paywall-card')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
    expect(fetchBilling).not.toHaveBeenCalled()
  })

  it('opens the platform on Add usage, then that button becomes Recheck', async () => {
    platformAuth.role = 'owner'
    renderCard()
    const button = await screen.findByRole('button', { name: 'Add usage' })
    expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
    expect(screen.getByText('Add usage credit to resume this answer.')).toBeInTheDocument()
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

    it('renders the CTA frame in place of the CTA button', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expectEmbedUrl({ view: 'topup', intent: 'topup', surface: 'cta' })
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-embedded', 'true')
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')
      expect(screen.getByTestId('paywall-card')).not.toHaveClass('max-w-md')
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Add usage' })).not.toBeInTheDocument()
      expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
      expect(screen.getByText('Add usage credit to resume this answer.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
      expect(openExternalUrl).not.toHaveBeenCalled()
    })

    it('hides the loading overlay once the CTA reports ready, without expanding', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expect(screen.getByTestId('billing-embed-loading')).toBeInTheDocument()
      postEmbedMessage(PLATFORM_ORIGIN, 'ready')
      expect(screen.queryByTestId('billing-embed-loading')).not.toBeInTheDocument()
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
    })

    it('keeps the native size reference until the iframe is ready to accept clicks', async () => {
      renderCard()
      const frame = await screen.findByTestId('billing-cta-frame')
      expect(frame).not.toBeVisible()
      expect(screen.getByTestId('billing-cta-size-reference')).toBeDisabled()
      postEmbedMessage(PLATFORM_ORIGIN, 'ready')
      expect(frame).toBeVisible()
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveClass('invisible')
    })

    it('does not let a resize grow the compact CTA', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      const body = screen.getByTestId('billing-cta-body')
      expect(body.style.height).toBe('')
      expect(body.className).not.toContain('w-full')
      expect(screen.getByTestId('billing-cta-size-reference').className).toContain('h-8')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 312.4 })
      expect(body.style.height).toBe('')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 5000 })
      expect(body.style.height).toBe('')
    })

    it('shows only a light authorization hint and clears it after access is restored', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { label: 'Add usage', hint: 'Allow access to billing to continue.' })
      expect(screen.getByTestId('billing-cta-hint')).toHaveTextContent('Allow access to billing to continue.')
      expect(screen.getByTestId('billing-cta-hint').className).toContain('text-xs')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { hint: '' })
      expect(screen.queryByTestId('billing-cta-hint')).not.toBeInTheDocument()
    })

    it('ignores forged or oversized CTA hints', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      postEmbedMessage(HOSTILE_ORIGIN, 'cta-state', { hint: 'Wrong price' })
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { hint: 'Wrong price' }, window)
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { hint: 'Wrong price', orgId: 'other' })
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { hint: 'x'.repeat(301) })
      expect(screen.queryByTestId('billing-cta-hint')).not.toBeInTheDocument()
    })

    it('draws the subscribe quote from the platform CTA and clears on billing-updated', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-cta-frame')
      expect(screen.getByTestId('paywall-subscribe')).toHaveClass('flex-col', 'sm:flex-row')
      expect(screen.getByTestId('paywall-subscribe-aside')).toHaveClass('border-t', 'sm:border-l', 'sm:min-w-[200px]')
      expect(screen.getByTestId('paywall-subscribe-aside')).not.toHaveClass('min-w-[200px]', 'shrink-0')
      expect(screen.getByTestId('paywall-card')).toHaveClass('px-4', 'sm:px-6')
      expect(screen.getByText('Your trial has ended.')).toBeInTheDocument()
      expect(screen.getByText('Upgrade to Pro to keep going.')).toBeInTheDocument()
      expect(screen.getByText('Team cloud + private desktop workspaces')).toBeInTheDocument()
      expect(screen.queryByTestId('paywall-plan')).not.toBeInTheDocument()
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { label: 'Upgrade to Pro', hint: '', seats: 2, seatPriceCents: 20000 })
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent('$400/mo')
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent(/2 seats\s*×\s*\$200\/mo/)
      expect(screen.queryByTestId('billing-cta-hint')).not.toBeInTheDocument()
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveClass('w-full')
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Billing updated. You can continue.'))
      expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument()
    })

    it('sizes the subscribe CTA box for the promo line the platform draws under the button', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-cta-frame')
      const promoLine = screen.getByTestId('billing-cta-promo-reference')
      expect(promoLine).toHaveTextContent('Have a promo code?')
      expect(promoLine).toHaveClass('mt-1.5', 'h-4')
      expect(promoLine).toHaveAttribute('aria-hidden', 'true')
      postEmbedMessage(PLATFORM_ORIGIN, 'ready')
      expect(promoLine).toHaveClass('invisible')
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveClass('invisible')
    })

    it('does not draw a promo line for the top-up or payment CTA', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expect(screen.queryByTestId('billing-cta-promo-reference')).not.toBeInTheDocument()
    })

    it('expands the subscribe CTA under both columns for the promo form and collapses on close, keeping the iframe', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      const frame = await screen.findByTestId('billing-cta-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { label: 'Upgrade to Pro', hint: 'Promo HALF3 applied.', seats: 1, seatPriceCents: 20000 })
      expect(screen.getByTestId('billing-cta-hint')).toHaveTextContent('Promo HALF3 applied.')

      await expandCta()
      const aside = screen.getByTestId('paywall-subscribe-aside')
      expect(aside).toHaveAttribute('data-expanded', 'true')
      expect(aside).toHaveClass('w-full', 'sm:basis-full', 'items-stretch')
      expect(aside).not.toHaveClass('sm:border-l', 'sm:min-w-[200px]')
      expect(screen.getByTestId('paywall-subscribe')).toHaveClass('sm:flex-wrap')
      expect(screen.getByTestId('paywall-card')).not.toHaveClass('max-w-md')
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent('$200/mo')
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveClass('hidden')
      expect(screen.getByTestId('billing-cta-promo-reference')).toHaveClass('hidden')
      expect(screen.queryByTestId('billing-cta-hint')).not.toBeInTheDocument()
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 180 })
      expect(screen.getByTestId('billing-cta-body').style.height).toBe('180px')
      expect(screen.getByTestId('billing-cta-frame')).toBe(frame)

      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { label: 'Upgrade to Pro', hint: 'Promo HALF3 applied.', seats: 1, seatPriceCents: 10000 })
      postEmbedMessage(PLATFORM_ORIGIN, 'close')
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')
      expect(aside).toHaveClass('sm:border-l', 'sm:min-w-[200px]')
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent('$100/mo')
      expect(screen.getByTestId('billing-cta-hint')).toHaveTextContent('Promo HALF3 applied.')
      expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
    })

    it('widens only the subscribe card past the gutter at full column width', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-cta-frame')
      expect(screen.getByTestId('paywall-card-frame')).toHaveClass('min-[800px]:-mx-4', 'min-[800px]:px-0')
    })

    it('keeps the top-up card inside the gutter', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expect(screen.getByTestId('paywall-card-frame')).toHaveClass('px-4')
      expect(screen.getByTestId('paywall-card-frame')).not.toHaveClass('min-[800px]:-mx-4')
    })

    it('ignores a forged or malformed subscribe quote', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-cta-frame')
      postEmbedMessage(HOSTILE_ORIGIN, 'cta-state', { seats: 2, seatPriceCents: 20000 })
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { seats: 2, seatPriceCents: 20000 }, window)
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { seats: 2.5, seatPriceCents: 20000 })
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { seats: 2, seatPriceCents: '20000' })
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { seats: 0, seatPriceCents: 20000 })
      expect(screen.queryByTestId('paywall-plan')).not.toBeInTheDocument()
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { seats: 1, seatPriceCents: 20000 })
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent('$200/mo')
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent(/1 seat\s*×\s*\$200\/mo/)
      postEmbedMessage(PLATFORM_ORIGIN, 'cta-state', { seats: 12, seatPriceCents: 20000 })
      expect(screen.getByTestId('paywall-plan')).toHaveTextContent('$2,400/mo')
    })

    it('sends theme changes only to the configured platform iframe', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      const send = vi.spyOn(frameWindow(), 'postMessage')
      postEmbedMessage(PLATFORM_ORIGIN, 'ready')
      expect(send).toHaveBeenCalledWith({ type: 'gamut-billing-theme', orgId: 'org_123', theme: 'light' }, PLATFORM_ORIGIN)
      document.documentElement.classList.add('dark')
      await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'gamut-billing-theme', orgId: 'org_123', theme: 'dark' }, PLATFORM_ORIGIN))
      document.documentElement.classList.remove('dark')
      send.mockRestore()
    })

    it('expands the same CTA iframe in place on a validated open-billing event, with no dialog or second frame', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      const before = embedFrame()
      const srcBefore = before.src
      const frame = await expandCta()
      expect(frame).toBe(before)
      expect(embedFrame().src).toBe(srcBefore)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
      expect(screen.getByTestId('paywall-card')).toHaveClass('max-w-md')
      expect(screen.getByTestId('billing-cta-body')).toHaveClass('w-full')
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveClass('hidden')
      expect(screen.getByTestId('paywall-actions')).toHaveAttribute('data-expanded', 'true')
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
    })

    it('collapses back to the banner on a validated close event, keeping the same iframe document', async () => {
      renderCard()
      const frame = await expandCta()
      const srcBefore = embedFrame().src
      postEmbedMessage(HOSTILE_ORIGIN, 'close')
      postEmbedMessage(PLATFORM_ORIGIN, 'close', {}, window)
      postEmbedMessage(PLATFORM_ORIGIN, 'close', { orgId: 'org_other' })
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true')
      postEmbedMessage(PLATFORM_ORIGIN, 'close')
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')
      expect(screen.getByTestId('paywall-card')).not.toHaveClass('max-w-md')
      expect(embedFrame()).toBe(frame)
      expect(embedFrame().src).toBe(srcBefore)
      expect(screen.getByText('You need more usage credit to continue')).toBeInTheDocument()
      expect(screen.getByTestId('billing-cta-body')).not.toHaveClass('w-full')
    })

    it('shows Dismiss when dismissible, including while expanded', async () => {
      renderCard(undefined, true, PRESENTATION, true)
      await screen.findByTestId('billing-cta-frame')
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
      await expandCta()
      act(() => { screen.getByRole('button', { name: 'Dismiss' }).click() })
      expect(screen.queryByTestId('billing-cta-frame')).not.toBeInTheDocument()
      expect(screen.getByTestId('composer')).toBeInTheDocument()
    })

    it('ignores open-billing from a hostile origin, a non-iframe source, or another org', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      postEmbedMessage(HOSTILE_ORIGIN, 'open-billing')
      postEmbedMessage(PLATFORM_ORIGIN, 'open-billing', {}, window)
      postEmbedMessage(PLATFORM_ORIGIN, 'open-billing', { orgId: 'org_other' })
      await act(async () => {})
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')
      expect(screen.queryByTestId('billing-embed-frame')).not.toBeInTheDocument()
    })

    it('sizes the expanded CTA frame from the platform resize event, clamped and capped to the viewport', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expect(screen.getByTestId('billing-cta-body').style.maxHeight).toBe('')
      await expandCta()
      const body = screen.getByTestId('billing-cta-body')
      expect(body.style.maxHeight).toBe('calc(100dvh - 160px)')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 312.4 })
      expect(body.style.height).toBe('313px')
      postEmbedMessage(PLATFORM_ORIGIN, 'resize', { height: 5000 })
      expect(body.style.height).toBe('640px')
      postEmbedMessage(window.location.origin, 'resize', { height: 200 })
      expect(body.style.height).toBe('640px')
    })

    it('rechecks after hosted checkout and stays expanded while still blocked', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      const before = fetchBilling.mock.calls.length
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(fetchBilling.mock.calls.length).toBeGreaterThan(before))

      const frame = await expandCta()
      const after = fetchBilling.mock.calls.length
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(fetchBilling.mock.calls.length).toBeGreaterThan(after))
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'true')
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
    })

    it('removes the card and toasts once an inline top-up clears billing', async () => {
      renderCard()
      await expandCta()
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(screen.getByTestId('composer')).toBeInTheDocument()
      expect(toastSuccess).toHaveBeenCalledWith('Billing updated. You can continue.')
    })

    it('keeps the expanded panel and holds the toast while a settings save is pending, then releases on the settled update', async () => {
      renderCard()
      const frame = await expandCta()
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { pending: true })
      // The allowed snapshot lands (composer unblocked) but the card stays.
      await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))

      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true')
      expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
      expect(screen.getByTestId('composer')).toBeInTheDocument()
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(mocks.track).not.toHaveBeenCalledWith('paywall_cleared', expect.anything())

      // A non-boolean `pending` reads as settled.
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { pending: 'yes' })
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(screen.getByTestId('composer')).toBeInTheDocument()
      expect(toastSuccess).toHaveBeenCalledTimes(1)
      expect(mocks.track).toHaveBeenCalledWith('paywall_cleared', { ctaKind: 'topup', handedOff: false })
    })

    it('keeps the open panel when the 5s poll clears billing before the platform reports the outcome, then holds through a late pending failure', async () => {
      vi.useFakeTimers({ toFake: ['setInterval'] })
      try {
        renderCard()
        const frame = await expandCta()
        // The charge landed but the panel is still saving settings: no message yet.
        fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PAYWALL_RECHECK_INTERVAL_MS)
        })
        await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))
        expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true')
        expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
        expect(screen.getByTestId('composer')).toBeInTheDocument()
        expect(toastSuccess).not.toHaveBeenCalled()

        // The settings save fails after the poll already cleared: the frame must still be there.
        postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { pending: true })
        await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
        expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
        expect(toastSuccess).not.toHaveBeenCalled()

        postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
        await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
        expect(toastSuccess).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps holding through the card-saved update, so a poll clearing the later purchase cannot drop a settings failure', async () => {
      vi.useFakeTimers({ toFake: ['setInterval'] })
      try {
        fetchBilling.mockResolvedValue(billing({ hasPaymentMethod: false }))
        renderCard()
        await screen.findByTestId('billing-cta-frame')
        expectEmbedUrl({ view: 'topup', surface: 'cta', cta: 'add_card' })

        // Card setup finished: the platform opens the purchase panel and reports the saved
        // card as a pending update (the purchase itself is still to come).
        fetchBilling.mockResolvedValue(billing())
        const frame = await expandCta()
        const before = fetchBilling.mock.calls.length
        postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { pending: true })
        await waitFor(() => expect(fetchBilling.mock.calls.length).toBeGreaterThan(before))
        await waitFor(() => expect(screen.queryByText('Add a payment method')).not.toBeInTheDocument())
        expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'true')
        expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true')
        expect(screen.getByTestId('billing-cta-frame')).toBe(frame)

        // Purchase charged; settings save still in flight when the poll sees the credit.
        fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PAYWALL_RECHECK_INTERVAL_MS)
        })
        await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))
        expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
        expect(toastSuccess).not.toHaveBeenCalled()

        postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { pending: true })
        await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
        expect(screen.getByTestId('billing-cta-frame')).toBe(frame)

        postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
        await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
        expect(toastSuccess).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps the open panel when a focus refresh clears billing, until the platform reports the outcome', async () => {
      renderCard()
      const frame = await expandCta()
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      act(() => { window.dispatchEvent(new Event('focus')) })
      await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))
      expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
      expect(toastSuccess).not.toHaveBeenCalled()

      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(toastSuccess).toHaveBeenCalledTimes(1)
    })

    it('releases the open-panel hold on close even when billing cleared with no platform update', async () => {
      renderCard()
      await expandCta()
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      act(() => { window.dispatchEvent(new Event('focus')) })
      await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))

      postEmbedMessage(PLATFORM_ORIGIN, 'close')
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      // Nothing was purchased in-panel, so no "billing updated" toast.
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('releases a pending settings hold when the panel closes', async () => {
      renderCard()
      await expandCta()
      fetchBilling.mockResolvedValue(billing({ access: ALLOWED }))
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated', { pending: true })
      await waitFor(() => expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-blocked', 'false'))
      expect(toastSuccess).not.toHaveBeenCalled()

      postEmbedMessage(PLATFORM_ORIGIN, 'close')
      await waitFor(() => expect(screen.queryByTestId('paywall-card')).not.toBeInTheDocument())
      expect(toastSuccess).toHaveBeenCalledTimes(1)
    })

    it('keeps the same iframe document when saving a card flips the CTA from add_card to topup', async () => {
      fetchBilling.mockResolvedValue(billing({ hasPaymentMethod: false }))
      renderCard()
      const frame = await screen.findByTestId('billing-cta-frame')
      expectEmbedUrl({ view: 'topup', surface: 'cta', cta: 'add_card' })
      expect(screen.getByText('Add a payment method')).toBeInTheDocument()

      fetchBilling.mockResolvedValue(billing())
      await expandCta()
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expect(screen.queryByText('Add a payment method')).not.toBeInTheDocument())
      expect(screen.queryByText('You need more usage credit to continue')).not.toBeInTheDocument()
      expect(screen.getByTestId('billing-cta-frame')).toBe(frame)
      expectEmbedUrl({ view: 'topup', surface: 'cta', cta: 'add_card' })
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'true')
    })

    it('remounts the frame with the panel that matches the CTA after a recheck changes the view', async () => {
      fetchBilling.mockResolvedValue(billing({ subscription: { status: 'active', paymentStatus: 'past_due', currentPeriodEnd: null } }))
      renderCard()
      const paymentFrame = await screen.findByTestId('billing-cta-frame')
      expectEmbedUrl({ view: 'payment', surface: 'cta' })
      postEmbedMessage(PLATFORM_ORIGIN, 'open-billing')
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')

      fetchBilling.mockResolvedValue(billing())
      postEmbedMessage(PLATFORM_ORIGIN, 'billing-updated')
      await waitFor(() => expectEmbedUrl({ view: 'topup', intent: 'topup', surface: 'cta' }))
      expect(screen.getByTestId('billing-cta-frame')).not.toBe(paymentFrame)
      expect(screen.getByTestId('paywall-card')).toHaveAttribute('data-expanded', 'false')
      await expandCta()
      expect(screen.queryByText('You need more usage credit to continue')).not.toBeInTheDocument()
      expect(screen.queryByText('Add usage credit to resume this answer.')).not.toBeInTheDocument()
    })

    it('falls back to opening billing externally when the workspace has no org id, then offers a recheck', async () => {
      platformAuth.orgId = null
      renderCard()
      const fallback = await screen.findByRole('button', { name: 'Open billing in a new tab' })
      expect(fallback).toHaveAttribute('title', 'Could not open billing.')
      expect(screen.getByTestId('billing-cta-hint')).toHaveTextContent('Could not open billing.')
      expect(screen.queryByTestId('billing-cta-frame')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
      act(() => { fallback.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(new URL(openExternalUrl.mock.calls[0][0]).searchParams.get('intent')).toBe('topup')
      expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument()
    })

    it('falls back when platform base URL is missing', async () => {
      platformAuth.platformBaseUrl = null
      renderCard()
      const fallback = await screen.findByRole('button', { name: 'Open billing in a new tab' })
      expect(fallback).toHaveAttribute('title', 'Could not open billing.')
      expect(screen.queryByTestId('billing-cta-frame')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    })

    it('falls back when platform base URL is not a valid origin', async () => {
      platformAuth.platformBaseUrl = 'not-a-url'
      renderCard()
      expect(await screen.findByRole('button', { name: 'Open billing in a new tab' })).toHaveAttribute('title', 'Could not open billing.')
      expect(screen.queryByTestId('billing-cta-frame')).not.toBeInTheDocument()
    })

    it('falls back when the platform page never reports ready', async () => {
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
      try {
        renderCard()
        await screen.findByTestId('billing-cta-frame')
        const readyTimer = setTimeoutSpy.mock.calls.find(([, delay]) => delay === FRAME_READY_TIMEOUT_MS)
        expect(readyTimer).toBeDefined()
        act(() => { (readyTimer![0] as () => void)() })
        const fallback = screen.getByRole('button', { name: 'Open billing in a new tab' })
        expect(fallback).toHaveAttribute('title', 'Billing is taking too long to load.')
        expect(screen.getByTestId('billing-cta-hint')).toHaveTextContent('Billing is taking too long to load.')
        expect(screen.queryByTestId('billing-cta-frame')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('offers the compact external link when the CTA reports the session expired', async () => {
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      postEmbedMessage(PLATFORM_ORIGIN, 'session-expired')
      const fallback = screen.getByRole('button', { name: 'Open billing in a new tab' })
      expect(fallback).toHaveAttribute('title', 'This billing session has expired.')
      expect(screen.getByTestId('billing-cta-hint')).toHaveTextContent('This billing session has expired.')
    })

    it('embeds the add-card CTA when the org has no card yet', async () => {
      fetchBilling.mockResolvedValue(billing({ hasPaymentMethod: false }))
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expectEmbedUrl({ view: 'topup', surface: 'cta', cta: 'add_card' })
      expect(screen.queryByRole('button', { name: 'Add credit card' })).not.toBeInTheDocument()
    })

    it('embeds the subscribe CTA when a subscription is required', async () => {
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      await screen.findByTestId('billing-cta-frame')
      expectEmbedUrl({ view: 'subscribe', surface: 'cta' })
      expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveTextContent('Upgrade to Pro')
      expect(screen.getByTestId('billing-cta-size-reference')).toHaveClass('bg-brand')
    })

    it('embeds the payment CTA when the payment is past due', async () => {
      fetchBilling.mockResolvedValue(billing({ subscription: { status: 'active', paymentStatus: 'past_due', currentPeriodEnd: null } }))
      renderCard()
      await screen.findByTestId('billing-cta-frame')
      expectEmbedUrl({ view: 'payment', surface: 'cta' })
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
      expect(button).toHaveClass('bg-brand')
      expect(screen.getByText('Add usage credit to resume this answer.')).toHaveClass('text-[11px]')
      expect(screen.queryByTestId('billing-embed-body')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Recheck' })).toBeInTheDocument()
    })

    it('hands off the subscribe card in Electron with the blue button and no quote', async () => {
      ;(window as { electronAPI?: unknown }).electronAPI = {}
      renderCard('API Error: 402 {"error":"insufficient_balance","subscription_required":true}')
      const button = await screen.findByRole('button', { name: 'Upgrade to Pro' })
      expect(button).toHaveClass('bg-brand')
      expect(screen.getByTestId('paywall-subscribe')).toBeInTheDocument()
      expect(screen.queryByTestId('paywall-plan')).not.toBeInTheDocument()
      act(() => { button.click() })
      expect(openExternalUrl).toHaveBeenCalledWith(BILLING_URL)
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
