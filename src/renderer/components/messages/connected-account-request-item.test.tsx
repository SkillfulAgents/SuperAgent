// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useConnectedAccountsByToolkit: vi.fn(() => ({
    data: {
      accounts: [
        {
          id: 'acc-1',
          displayName: 'My GitHub Account',
          status: 'active',
          createdAt: new Date('2025-01-01'),
          composioConnectionId: 'conn-1',
          toolkitSlug: 'github',
        },
      ],
    },
    isLoading: false,
    refetch: vi.fn(),
  })),
  useInvalidateConnectedAccounts: vi.fn(() => vi.fn()),
  useRenameConnectedAccount: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}))

vi.mock('@shared/lib/composio/providers', () => ({
  getProvider: (slug: string) => ({
    slug,
    displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
  }),
}))

const defaultProps = {
  toolUseId: 'tu-1',
  toolkit: 'github',
  reason: 'Need to access your repos',
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

describe('ConnectedAccountRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Remove electronAPI to test web mode
    delete (window as any).electronAPI
  })

  it('renders pending state with toolkit name and reason', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    const githubElements = screen.getAllByText(/Github/i)
    expect(githubElements.length).toBeGreaterThan(0)
    expect(screen.getByText('Need to access your repos')).toBeInTheDocument()
  })

  it('renders account list', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    expect(screen.getByText('My GitHub Account')).toBeInTheDocument()
    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('provides account when selected and submitted', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    // Click to select the account
    await user.click(screen.getByText('My GitHub Account'))

    // Click Grant Access
    await user.click(screen.getByText(/Grant Access/))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/agents/my-agent/sessions/s-1/provide-connected-account',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('acc-1'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Access Granted')).toBeInTheDocument()
    })
    expect(defaultProps.onComplete).toHaveBeenCalled()
  })

  it('declines access request', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    await user.click(screen.getByText('Decline'))

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('provide-connected-account'),
        expect.objectContaining({
          body: expect.stringContaining('"decline":true'),
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Declined')).toBeInTheDocument()
    })
  })

  it('grant access button is disabled when no account is selected', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    const grantButton = screen.getByText(/Grant Access/).closest('button')!
    expect(grantButton).toBeDisabled()
  })

  it('shows connect new account button', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    expect(screen.getByText('Connect New Account')).toBeInTheDocument()
  })

  it('shows error on API failure', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Connection failed' }),
    })

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    await user.click(screen.getByText('My GitHub Account'))
    await user.click(screen.getByText(/Grant Access/))

    await waitFor(() => {
      expect(screen.getByText('Connection failed')).toBeInTheDocument()
    })
  })
})
