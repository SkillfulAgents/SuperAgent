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
}

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: platformAuth }),
}))

const SPEND_CAP =
  'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'

beforeEach(() => {
  platformAuth.connected = true
  platformAuth.orgId = 'org_123'
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
      />,
    )

    const card = screen.getByTestId('provider-error-card')
    expect(card).toHaveTextContent('Insufficient Balance')
    expect(card).toHaveAttribute('data-severity', 'error')
    expect(card).toHaveClass('bg-red-50', 'dark:bg-red-950')

    fireEvent.click(screen.getByRole('link', { name: /go to billing/i }))
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
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
})
