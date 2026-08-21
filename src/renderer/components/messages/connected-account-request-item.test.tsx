// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { renderWithProviders } from '@renderer/test/test-utils'
import { useConnectedAccountsByToolkit, useDeleteConnectedAccount } from '@renderer/hooks/use-connected-accounts'

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
          createdAt: new Date('2025-01-01').toISOString(),
          providerConnectionId: 'conn-1',
            providerName: 'composio',
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
  useDeleteConnectedAccount: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
}))

vi.mock('@shared/lib/account-providers', () => ({
  getProvider: (slug: string) => ({
    slug,
    displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
  }),
}))

vi.mock('@renderer/hooks/use-oauth-reconnect', () => ({
  useOAuthReconnect: () => vi.fn(),
}))

vi.mock('@renderer/components/ui/policy-summary-pill', () => ({
  PolicySummaryPill: () => null,
}))

vi.mock('@renderer/components/settings/scope-policy-editor', () => ({
  ScopePolicyEditor: () => null,
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
    // Restore default mock implementation (clearAllMocks doesn't reset mockReturnValue)
    vi.mocked(useConnectedAccountsByToolkit).mockImplementation(() => ({
      data: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'My GitHub Account',
            status: 'active',
            createdAt: new Date('2025-01-01').toISOString(),
            providerConnectionId: 'conn-1',
            providerName: 'composio',
            toolkitSlug: 'github',
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    }) as any)
    // Remove electronAPI to test web mode
    delete (window as any).electronAPI
  })

  it('renders pending state with toolkit name and reason', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    const githubElements = screen.getAllByText(/Github/i)
    expect(githubElements.length).toBeGreaterThan(0)
    expect(screen.getByText('Need to access your repos')).toBeInTheDocument()
  })

  it('renders account list with checkbox', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    expect(screen.getByText('My GitHub Account')).toBeInTheDocument()
    // Account option uses a checkbox for selection
    const checkbox = screen.getByRole('checkbox')
    expect(checkbox).toBeInTheDocument()
  })

  it('auto-selects when there is only one account', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    // With a single account, the component auto-selects it
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('provides account when submitted (auto-selected single account)', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: () => ({}) })

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    // Single account is auto-selected, so "Allow Access (1)" button should be enabled
    await user.click(screen.getByText(/Allow Access/))

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

    await user.click(screen.getByText('Deny'))

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

  it('allow access button is disabled when no account is selected', () => {
    // Mock two accounts so auto-select does not trigger (only triggers for exactly 1)
    vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({
      data: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'My GitHub Account',
            status: 'active',
            createdAt: new Date('2025-01-01').toISOString(),
            providerConnectionId: 'conn-1',
            providerName: 'composio',
            toolkitSlug: 'github',
          },
          {
            id: 'acc-2',
            displayName: 'Work GitHub Account',
            status: 'active',
            createdAt: new Date('2025-02-01').toISOString(),
            providerConnectionId: 'conn-2',
            providerName: 'composio',
            toolkitSlug: 'github',
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as any)

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    const allowButton = screen.getByText(/Allow Access/).closest('button')!
    expect(allowButton).toBeDisabled()
  })

  it('shows add new account button', () => {
    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    expect(screen.getByText('Add New Account')).toBeInTheDocument()
  })

  it('does not auto-select expired accounts and shows reconnect button', () => {
    vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({
      data: {
        accounts: [
          {
            id: 'acc-1',
            displayName: 'Expired GitHub',
            status: 'expired',
            createdAt: new Date('2025-01-01').toISOString(),
            providerConnectionId: 'conn-1',
            providerName: 'composio',
            toolkitSlug: 'github',
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as any)

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    // No checkbox for expired accounts — shows reconnect button instead
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getAllByText('Reconnect').length).toBeGreaterThan(0)
  })

  it('shows checkbox for active and reconnect for expired in mixed list', async () => {
    vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({
      data: {
        accounts: [
          {
            id: 'acc-active',
            displayName: 'Active GitHub',
            status: 'active',
            createdAt: new Date('2025-01-01').toISOString(),
            providerConnectionId: 'conn-1',
            providerName: 'composio',
            toolkitSlug: 'github',
          },
          {
            id: 'acc-expired',
            displayName: 'Expired GitHub',
            status: 'expired',
            createdAt: new Date('2025-02-01').toISOString(),
            providerConnectionId: 'conn-2',
            providerName: 'composio',
            toolkitSlug: 'github',
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as any)

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
    // Active account gets a checkbox, expired gets reconnect button
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(1)
    expect(screen.getAllByText('Reconnect').length).toBeGreaterThan(0)
  })

  it('deletes an account after confirming in the dialog', async () => {
    const user = userEvent.setup()
    const deleteMutate = vi.fn().mockResolvedValue(undefined)
    vi.mocked(useDeleteConnectedAccount).mockReturnValue({
      mutateAsync: deleteMutate,
      isPending: false,
    } as any)

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    // Open the per-account action menu and choose Delete
    await user.click(screen.getByTestId('account-option-menu-acc-1'))
    await user.click(screen.getByTestId('account-option-delete-acc-1'))

    // A confirmation dialog appears; delete only fires after confirming
    expect(deleteMutate).not.toHaveBeenCalled()
    const confirmButtons = await screen.findAllByRole('button', { name: /^delete$/i })
    await user.click(confirmButtons[confirmButtons.length - 1])

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledWith('acc-1')
    })
  })

  it('does not delete when the confirmation is cancelled', async () => {
    const user = userEvent.setup()
    const deleteMutate = vi.fn().mockResolvedValue(undefined)
    vi.mocked(useDeleteConnectedAccount).mockReturnValue({
      mutateAsync: deleteMutate,
      isPending: false,
    } as any)

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    await user.click(screen.getByTestId('account-option-menu-acc-1'))
    await user.click(screen.getByTestId('account-option-delete-acc-1'))

    await user.click(await screen.findByRole('button', { name: /^cancel$/i }))

    expect(deleteMutate).not.toHaveBeenCalled()
  })

  it('shows error on API failure', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Connection failed' }),
    })

    renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

    // Wait for auto-select to fire (useEffect), then the button becomes enabled
    const allowButton = await screen.findByRole('button', { name: /Allow Access/ })
    await waitFor(() => {
      expect(allowButton).not.toBeDisabled()
    })

    await user.click(allowButton)

    await waitFor(() => {
      expect(screen.getByText(/Connection failed/)).toBeInTheDocument()
    })
  })
})
