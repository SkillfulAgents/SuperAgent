// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { parsePlatformErrorResponse } from '@shared/lib/llm-provider/platform-error-presentation'
import { resolvePresentationMarkdown } from '@shared/lib/llm-provider/error-presentation'

import { ProviderErrorCard, ProviderErrorView } from './provider-error-card'

const platformAuth = {
  connected: true as boolean,
  platformBaseUrl: 'https://platform.example.com' as string | null,
  orgId: 'org_123' as string | null,
  role: 'owner' as string | null,
}

const billingInfo = {
  data: undefined as {
    stale?: boolean
    billing?: {
      configured: boolean
      subscription: { status: string | null; paymentStatus?: string | null }
      seat: { balanceCents: number; startingBalanceCents: number } | null
      orgPool: { poolBalanceCents: number }
      hasPaymentMethod?: boolean
      access?: { allowed: boolean; reason: string }
    }
  } | undefined,
  isLoading: false,
}

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))

vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: () => billingInfo,
}))

const SPEND_CAP =
  'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'

beforeEach(() => {
  platformAuth.connected = true
  platformAuth.orgId = 'org_123'
  platformAuth.role = 'owner'
  billingInfo.data = undefined
  billingInfo.isLoading = false
})

describe('ProviderErrorView', () => {
  it('renders spend-cap markdown as a warning with a raise link', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

    const parsed = parsePlatformErrorResponse(429, SPEND_CAP)!
    render(
      <ProviderErrorView
        presentation={{
          ...parsed,
          message: resolvePresentationMarkdown(parsed.message, platformAuth),
        }}
      />,
    )

    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('Spend Limit Reached')
    expect(card).toHaveTextContent('A spend cap for this workspace was reached. It resets within 30 days.')
    expect(card).not.toHaveTextContent('LLM Provider Error')
    expect(card).toHaveAttribute('data-severity', 'warning')
    expect(card).toHaveClass('bg-orange-50', 'dark:bg-orange-950')

    fireEvent.click(screen.getByRole('link', { name: /raise spend limit/i }))
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
  })

  it('renders insufficient-balance markdown with a billing link', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

    const parsed = parsePlatformErrorResponse(
      402,
      'API Error: 402 Workspace has insufficient balance. Top up to continue.',
    )!
    render(
      <ProviderErrorView
        presentation={{
          ...parsed,
          message: resolvePresentationMarkdown(parsed.message, platformAuth),
        }}
        paywallCta={{
          kind: 'go_to_billing',
          href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
        }}
      />,
    )

    // Legacy 402s render the neutral paywall card, not the red error banner.
    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('You need more usage credit to continue')
    expect(card).not.toHaveAttribute('data-severity')
    expect(card).not.toHaveClass('bg-red-50')

    fireEvent.click(screen.getByRole('button', { name: /go to billing/i }))
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
  })

  it('uses neutral copy while an unresolved billing snapshot loads', () => {
    render(
      <ProviderErrorView
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**You need more usage credit to continue**',
          paywall: {},
        }}
        paywallCta={{ kind: 'subscribe', href: 'https://platform.example.com/billing' }}
        paywallLoading
      />,
    )

    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('Checking billing')
    expect(card).not.toHaveTextContent('You need more usage credit')
  })

  it('renders a Subscribe button for a subscription-required paywall', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

    render(
      <ProviderErrorView
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**Subscription Required:** Subscribe to continue running agents.',
          paywall: { subscriptionRequired: true },
        }}
        paywallCta={{
          kind: 'subscribe',
          href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
        }}
      />,
    )

    expect(screen.getByTestId('provider-error-card')).toHaveTextContent('Subscribe to keep going')
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }))
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
  })

  it('tells a non-admin to ask an admin to top up', () => {
    render(
      <ProviderErrorView
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**Insufficient Balance:** This workspace is out of credits.',
          paywall: { subscriptionRequired: false },
        }}
        paywallCta={{
          kind: 'ask_admin',
          href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
        }}
      />,
    )
    // Ask-admin guidance lives in the card subtitle; the action is a plain
    // billing button rather than a top-up flow the member can't complete.
    expect(screen.getByTestId('provider-error-card')).toHaveTextContent(
      'Ask a workspace admin to resolve billing',
    )
    expect(screen.getByRole('button', { name: /go to billing/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /subscribe|add usage/i })).not.toBeInTheDocument()
  })

  it('opens the dashboard top-up hand-off when a card is already on file', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as {
      electronAPI?: { openExternal: typeof openExternal; desktopProtocol?: string }
    }).electronAPI = { openExternal, desktopProtocol: 'superagent' }

    render(
      <ProviderErrorView
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**Insufficient Balance:** This workspace is out of credits.',
          paywall: { subscriptionRequired: false },
        }}
        paywallCta={{
          kind: 'topup',
          href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
        }}
      />,
    )

    // No in-app purchase dialog — the button hands off to the dashboard with
    // the auto-open intent and the deep link back into the app.
    fireEvent.click(screen.getByRole('button', { name: /add usage/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing&intent=topup&return_app=superagent%3A%2F%2Fbilling-updated',
    )
  })

  it('renders a Go to billing button when the role is unknown', () => {
    render(
      <ProviderErrorView
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**Insufficient Balance:** This workspace is out of credits.',
          paywall: { subscriptionRequired: false },
        }}
        paywallCta={{
          kind: 'go_to_billing',
          href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
        }}
      />,
    )
    expect(screen.getByRole('button', { name: /go to billing/i })).toBeInTheDocument()
    expect(screen.queryByText(/ask a workspace admin/i)).not.toBeInTheDocument()
  })
})

describe('ProviderErrorCard', () => {
  it('renders a server-attached platform spend-cap presentation with a resolved link', () => {
    render(
      <ProviderErrorCard message={SPEND_CAP} presentation={parsePlatformErrorResponse(429, SPEND_CAP)!} />,
    )
    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('Spend Limit Reached')
    expect(screen.getByRole('link', { name: /raise spend limit/i })).toBeInTheDocument()
  })

  it('omits the link when org context is missing', () => {
    platformAuth.connected = false
    render(
      <ProviderErrorCard message={SPEND_CAP} presentation={parsePlatformErrorResponse(429, SPEND_CAP)!} />,
    )
    expect(screen.getByTestId('provider-error-card')).toHaveTextContent('Spend Limit Reached')
    expect(screen.queryByRole('link', { name: /raise spend limit/i })).not.toBeInTheDocument()
  })

  it('falls back to the generic banner when no presentation is attached', () => {
    render(<ProviderErrorCard message={SPEND_CAP} />)
    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('LLM Provider Error')
    expect(card).toHaveAttribute('data-severity', 'error')
    expect(screen.queryByRole('link', { name: /raise spend limit/i })).not.toBeInTheDocument()
  })

  it('resolves a subscribe CTA from the attached paywall and org role', () => {
    render(
      <ProviderErrorCard
        message="API Error: 402 Workspace has insufficient balance. Top up to continue."
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**Subscription Required:** Subscribe to continue running agents.',
          paywall: { subscriptionRequired: true },
        }}
      />,
    )
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument()
  })

})
