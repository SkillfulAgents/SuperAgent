// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { parsePlatformErrorResponse } from '@shared/lib/llm-provider/platform-error-presentation'

import { ProviderErrorCard, ProviderErrorView } from './provider-error-card'

const BILLING_URL = 'https://platform.example.com/dashboard/organizations/org_123?tab=billing'
const SPEND_CAP =
  'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'

describe('ProviderErrorView', () => {
  it('renders spend-cap markdown as a warning with a raise link', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { electronAPI?: { openExternal: typeof openExternal } }).electronAPI = {
      openExternal,
    }

    render(<ProviderErrorView presentation={parsePlatformErrorResponse(429, SPEND_CAP, BILLING_URL)!} />)

    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('Spend Limit Reached')
    expect(card).toHaveTextContent('A spend cap for this workspace was reached. It resets within 30 days.')
    expect(card).not.toHaveTextContent('LLM Provider Error')
    expect(card).toHaveAttribute('data-severity', 'warning')
    expect(card).toHaveClass('bg-orange-50', 'dark:bg-orange-950')

    fireEvent.click(screen.getByRole('link', { name: /raise spend limit/i }))
    expect(openExternal).toHaveBeenCalledWith(BILLING_URL)
  })

  it('renders the paywall copy as a plain card when a 402 falls back to the inline card', () => {
    render(
      <ProviderErrorView
        presentation={parsePlatformErrorResponse(
          402,
          'API Error: 402 Workspace has insufficient balance. Top up to continue.',
          BILLING_URL,
        )!}
      />,
    )

    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('You need more usage credit to continue')
    expect(card).toHaveAttribute('data-severity', 'error')
    expect(card).toHaveClass('bg-red-50', 'dark:bg-red-950')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('ProviderErrorCard', () => {
  it('renders a server-attached platform spend-cap presentation with its link', () => {
    render(
      <ProviderErrorCard message={SPEND_CAP} presentation={parsePlatformErrorResponse(429, SPEND_CAP, BILLING_URL)!} />,
    )
    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('Spend Limit Reached')
    expect(screen.getByRole('link', { name: /raise spend limit/i })).toBeInTheDocument()
  })

  it('renders plain text when the provider attached no link', () => {
    render(
      <ProviderErrorCard message={SPEND_CAP} presentation={parsePlatformErrorResponse(429, SPEND_CAP, null)!} />,
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
})
