// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
  data: undefined as { billing?: { hasPaymentMethod?: boolean } } | undefined,
  isLoading: false,
}

const paywallBilling = {
  topup: vi.fn(),
  setAutoReload: vi.fn(),
  setupCard: vi.fn(),
  confirmCard: vi.fn(),
  pending: false,
  error: null,
  setError: vi.fn(),
}

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))

vi.mock('@renderer/hooks/use-billing-info', () => ({
  useBillingInfo: () => billingInfo,
}))

vi.mock('@renderer/hooks/use-paywall-billing', () => ({
  usePaywallBilling: () => paywallBilling,
}))

const SPEND_CAP =
  'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'

beforeEach(() => {
  platformAuth.connected = true
  platformAuth.orgId = 'org_123'
  platformAuth.role = 'owner'
  billingInfo.data = undefined
  billingInfo.isLoading = false
  paywallBilling.topup.mockReset()
  paywallBilling.topup.mockResolvedValue(true)
  paywallBilling.setAutoReload.mockReset()
  paywallBilling.setAutoReload.mockResolvedValue(true)
  paywallBilling.setupCard.mockReset()
  paywallBilling.setupCard.mockResolvedValue(null)
  paywallBilling.confirmCard.mockReset()
  paywallBilling.pending = false
  paywallBilling.error = null
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

    expect(screen.getByTestId('provider-error-card')).toHaveTextContent('Subscription Required')
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
    expect(screen.getByTestId('provider-error-card')).toHaveTextContent('Ask a workspace admin to add usage credit')
    expect(screen.getByRole('button', { name: /go to billing/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /subscribe|add usage/i })).not.toBeInTheDocument()
  })

  it('renders top-up amounts when a card is already on file', () => {
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
          amountsCents: [5000, 10000, 20000, 40000],
        }}
      />,
    )
    // Amounts live in the dialog behind the single Add usage button.
    expect(screen.queryByRole('button', { name: '$50' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add usage/i }))
    const dialog = screen.getByRole('dialog', { name: /add more usage credit/i })
    expect(within(dialog).getByRole('tab', { name: /auto-refill/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('tab', { name: /one-time purchase/i })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '$50' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '$100' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '$200' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '$400' })).toBeInTheDocument()

    // A preset fills the amount field and arms Purchase.
    const purchase = within(dialog).getByRole('button', { name: /^purchase$/i })
    expect(purchase).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: '$100' }))
    expect(within(dialog).getByRole('spinbutton', { name: /amount in dollars/i })).toHaveValue(100)
    expect(purchase).toBeEnabled()
  })

  it('enables Purchase only for a valid typed amount', () => {
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
          amountsCents: [2000],
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /add usage/i }))
    const dialog = screen.getByRole('dialog', { name: /add more usage credit/i })
    const input = within(dialog).getByRole('spinbutton', { name: /amount in dollars/i })
    const purchase = within(dialog).getByRole('button', { name: /^purchase$/i })

    expect(purchase).toBeDisabled()
    fireEvent.change(input, { target: { value: '5' } })
    expect(purchase).toBeDisabled()
    fireEvent.change(input, { target: { value: '50' } })
    expect(purchase).toBeEnabled()
  })

  it('purchases a one-time top-up in-app', async () => {
    const openExternal = vi.fn()
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

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
          amountsCents: [5000, 10000, 20000, 40000],
        }}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add usage/i }))
    const dialog = screen.getByRole('dialog', { name: /add more usage credit/i })
    await user.click(within(dialog).getByRole('button', { name: '$100' }))
    await user.click(within(dialog).getByRole('button', { name: /^purchase$/i }))

    await waitFor(() => {
      expect(paywallBilling.topup).toHaveBeenCalledWith(10000)
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens the in-app card dialog from Add credit card', async () => {
    const openExternal = vi.fn()
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

    render(
      <ProviderErrorView
        presentation={{
          severity: 'error',
          icon: 'info',
          message: '**Insufficient Balance:** This workspace is out of credits.',
          paywall: { subscriptionRequired: false },
        }}
        paywallCta={{
          kind: 'add_card',
          href: 'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
        }}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add credit card/i }))

    expect(screen.getByRole('dialog', { name: /add credit card/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(paywallBilling.setupCard).toHaveBeenCalled()
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens the in-app card dialog from Change', async () => {
    const openExternal = vi.fn()
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

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
          amountsCents: [5000],
        }}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add usage/i }))
    const dialog = screen.getByRole('dialog', { name: /add more usage credit/i })
    await user.click(within(dialog).getByRole('button', { name: /^change$/i }))

    expect(screen.getByRole('dialog', { name: /add credit card/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(paywallBilling.setupCard).toHaveBeenCalled()
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('saves auto-refill in-app after consent', async () => {
    const openExternal = vi.fn()
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

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
          amountsCents: [5000],
        }}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /add usage/i }))
    const dialog = screen.getByRole('dialog', { name: /add more usage credit/i })
    await user.click(within(dialog).getByRole('tab', { name: /auto-refill/i }))
    const save = await waitFor(() => within(dialog).getByRole('button', { name: /save auto-refill/i }))
    expect(save).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    expect(save).toBeEnabled()
    await user.click(save)

    expect(paywallBilling.setAutoReload).toHaveBeenCalledWith({
      enabled: true,
      thresholdCents: 5000,
      topupAmountCents: 20000,
    })
    expect(openExternal).not.toHaveBeenCalled()
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
