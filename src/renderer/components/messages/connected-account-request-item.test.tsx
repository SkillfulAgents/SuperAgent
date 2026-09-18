// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { renderWithProviders } from '@renderer/test/test-utils'
import { useConnectedAccountsByToolkit, useDeleteConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import { LOGIN_WINDOW_CANCEL_DELAY_MS } from '@renderer/hooks/use-login-window'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
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

let mockPendingAccountId: string | null = null
vi.mock('@renderer/hooks/use-oauth-reconnect', () => ({
  useOAuthReconnect: () => ({
    reconnect: vi.fn(),
    pendingAccountId: mockPendingAccountId,
    canCancelPendingReconnect: false,
    cancelReconnect: vi.fn(),
  }),
}))

vi.mock('@renderer/components/ui/policy-summary-pill', () => ({
  PolicySummaryPill: () => null,
}))

vi.mock('@renderer/components/settings/scope-policy-editor', () => ({
  ScopePolicyEditor: ({ accountId }: { accountId: string }) => <div data-testid="policy-editor">{accountId}</div>,
}))

const defaultAccount = {
  id: 'acc-1',
  displayName: 'My GitHub Account',
  status: 'active',
  createdAt: new Date('2025-01-01').toISOString(),
  providerConnectionId: 'conn-1',
  providerName: 'composio',
  toolkitSlug: 'github',
}

const rowOf = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement

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

  it('submits a replacement to the agent-scoped endpoint without a session', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
    renderWithProviders(
      <ConnectedAccountRequestItem {...defaultProps} sessionId={undefined}
        replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />,
    )
    await user.click(screen.getByRole('button', { name: 'Replace connection' }))
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/agents/my-agent/reauth-request/reauth-1/replace-account',
      expect.objectContaining({ body: expect.stringContaining('"accountIds":["acc-1"]') }),
    )
    await waitFor(() => expect(defaultProps.onComplete).toHaveBeenCalledOnce())
  })

  it('keeps the replacement picker open when the server rejects the account', async () => {
    const user = userEvent.setup()
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Account not found' }) })
    renderWithProviders(
      <ConnectedAccountRequestItem {...defaultProps}
        replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />,
    )
    await user.click(screen.getByRole('button', { name: 'Replace connection' }))
    expect(await screen.findByText(/Account not found/)).toBeInTheDocument()
    expect(defaultProps.onComplete).not.toHaveBeenCalled()
  })

  it('selects only one account when replacing a connection', async () => {
    const user = userEvent.setup()
    const existing = vi.mocked(useConnectedAccountsByToolkit)('github')
    vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({
      ...existing,
      data: { accounts: [existing.data!.accounts[0], { ...existing.data!.accounts[0], id: 'acc-2' }] },
    })
    renderWithProviders(
      <ConnectedAccountRequestItem {...defaultProps}
        replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />,
    )
    const [first, second] = screen.getAllByRole('checkbox')
    await user.click(first)
    await user.click(second)
    expect(first).not.toBeChecked()
    expect(second).toBeChecked()
  })

  it('connects a new owned account and uses it instead of the previous selection', async () => {
    const user = userEvent.setup()
    const existing = vi.mocked(useConnectedAccountsByToolkit)('github')
    const newAccount = { ...existing.data!.accounts[0], id: 'new-account', displayName: 'New GitHub Account' }
    const refetch = vi.fn(async () => {
      vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({
        ...existing, data: { accounts: [...existing.data!.accounts, newAccount] }, refetch,
      } as any)
      return { data: { accounts: [...existing.data!.accounts, newAccount] } }
    })
    vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...existing, refetch } as any)
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ redirectUrl: 'https://oauth.example' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
    renderWithProviders(
      <ConnectedAccountRequestItem {...defaultProps}
        replacement={{ requestId: 'reauth-1', onCancel: vi.fn() }} />,
    )
    await user.click(screen.getByRole('button', { name: 'Add New Account' }))
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/connected-accounts/initiate',
      expect.objectContaining({ body: JSON.stringify({ providerSlug: 'github', electron: false }) }))
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'oauth-callback', success: true, accountId: 'new-account' },
      }))
    })
    await user.click(screen.getByRole('button', { name: 'Replace connection' }))
    expect(mockApiFetch).toHaveBeenNthCalledWith(2,
      '/api/agents/my-agent/reauth-request/reauth-1/replace-account',
      expect.objectContaining({ body: expect.stringContaining('"accountIds":["new-account"]') }))
  })

  it('refreshes but does not auto-select an account whose sign-in was cancelled first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      // No accounts yet, so the card's one-account auto-select would fire on
      // the refreshed list if a cancelled sign-in did not spend it.
      const existing = vi.mocked(useConnectedAccountsByToolkit)('github')
      const newAccount = { ...existing.data!.accounts[0], id: 'new-account', displayName: 'New GitHub Account' }
      const refetch = vi.fn(async () => {
        vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...existing, data: { accounts: [newAccount] }, refetch } as any)
        return { data: { accounts: [newAccount] } }
      })
      vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...existing, data: { accounts: [] }, refetch } as any)
      mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ redirectUrl: 'https://oauth.example' }) })
      const { rerender } = renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: 'Connect' }))
      expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
      await act(async () => { await vi.advanceTimersByTimeAsync(LOGIN_WINDOW_CANCEL_DELAY_MS) })
      await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()

      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'oauth-callback', success: true, accountId: 'new-account' },
        }))
      })
      expect(refetch).toHaveBeenCalledOnce()
      rerender(<ConnectedAccountRequestItem {...defaultProps} />)
      expect(screen.getByText('New GitHub Account')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Allow Access' })).toBeDisabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels replacement without declining the parked request', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    renderWithProviders(
      <ConnectedAccountRequestItem {...defaultProps}
        replacement={{ requestId: 'reauth-1', onCancel }} />,
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(mockApiFetch).not.toHaveBeenCalled()
    expect(defaultProps.onComplete).not.toHaveBeenCalled()
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

  it('holds the whole card while a row reconnects', () => {
    const existing = vi.mocked(useConnectedAccountsByToolkit)('github')
    const expired = { ...existing.data!.accounts[0], id: 'acc-expired', displayName: 'Expired GitHub', status: 'expired' }
    const expiredToo = { ...expired, id: 'acc-expired-2', displayName: 'Other expired GitHub' }
    vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...existing, data: { accounts: [...existing.data!.accounts, expired, expiredToo] } } as any)
    mockPendingAccountId = 'acc-expired'
    try {
      renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
      expect(screen.getByRole('button', { name: 'Reconnecting…' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Add New Account' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
      expect(screen.getByRole('checkbox')).toBeDisabled()
    } finally {
      mockPendingAccountId = null
    }
  })

  describe('desktop callbacks', () => {
    let onOAuthCallback!: (params: { toolkit: string; connectionId: string }) => Promise<void>
    let finishComplete: Record<string, (ok?: boolean) => void>
    let initiateGate: Promise<void>
    let refetch: ReturnType<typeof vi.fn>

    // Two attempts, A then B: initiate hands out conn-A then conn-B, and each
    // completion request stays open until the test settles it.
    beforeEach(() => {
      ;(window as any).electronAPI = { onOAuthCallback: (cb: typeof onOAuthCallback) => { onOAuthCallback = cb; return () => {} } }
      const existing = vi.mocked(useConnectedAccountsByToolkit)('github')
      const account = (id: string) => ({ ...existing.data!.accounts[0], id, displayName: `Account ${id}` })
      refetch = vi.fn(async () => {
        const accounts = Object.keys(finishComplete).map(account)
        vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...existing, data: { accounts }, refetch } as any)
        return { data: { accounts } }
      })
      vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...existing, data: { accounts: [] }, refetch } as any)
      finishComplete = {}
      initiateGate = Promise.resolve()
      const ids = ['conn-A', 'conn-B']
      mockApiFetch.mockImplementation((path: string, init?: { body?: string }) => {
        if (path === '/api/connected-accounts/initiate') {
          const connectionId = ids.shift()
          return initiateGate.then(() => ({ ok: true, json: async () => ({ connectionId, redirectUrl: 'https://oauth.example' }) }))
        }
        const { connectionId } = JSON.parse(init!.body!)
        return new Promise((resolve) => {
          finishComplete[connectionId] = (ok = true) => resolve({ ok, json: async () => (ok ? { account: { id: connectionId } } : { error: `${connectionId} failed` }) })
        })
      })
    })

    it('keeps a newer sign-in\'s choice when an older completion lands after it', async () => {
      const user = userEvent.setup()
      const { rerender } = renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
      await user.click(screen.getByRole('button', { name: 'Connect' }))

      // A's callback lands: the window closes at once and the card is free
      // again, so B can start while A's completion request is still open.
      fakeLoginWindow.close.mockClear()
      const completionA = onOAuthCallback({ toolkit: 'github', connectionId: 'conn-A' })
      await act(async () => {})
      expect(fakeLoginWindow.close).toHaveBeenCalled()
      await user.click(screen.getByRole('button', { name: 'Connect' }))
      expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()

      // B finishes first and is selected.
      const completionB = onOAuthCallback({ toolkit: 'github', connectionId: 'conn-B' })
      await act(async () => { finishComplete['conn-B'](); await completionB })
      rerender(<ConnectedAccountRequestItem {...defaultProps} />)
      expect(screen.getByRole('button', { name: 'Allow Access (1)' })).toBeEnabled()
      expect(screen.getByTestId('policy-editor')).toHaveTextContent('conn-B')

      // A's completion lands last: it refreshes, and selects nothing over B's choice.
      await act(async () => { finishComplete['conn-A'](); await completionA })
      rerender(<ConnectedAccountRequestItem {...defaultProps} />)
      expect(screen.getByRole('button', { name: 'Allow Access (1)' })).toBeEnabled()
      expect(within(rowOf('Account conn-B')).getByRole('checkbox')).toBeChecked()
      expect(screen.getByTestId('policy-editor')).toHaveTextContent('conn-B')
    })

    it('does not report an older attempt\'s failure once a newer one has started', async () => {
      const user = userEvent.setup()
      renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
      await user.click(screen.getByRole('button', { name: 'Connect' }))
      const completionA = onOAuthCallback({ toolkit: 'github', connectionId: 'conn-A' })
      await act(async () => {})
      await user.click(screen.getByRole('button', { name: 'Connect' }))

      await act(async () => { finishComplete['conn-A'](false); await completionA })
      expect(screen.queryByText(/conn-A failed/)).toBeNull()
    })

    it('lets a row reconnect started after a claim stop that claim from selecting', async () => {
      const user = userEvent.setup()
      const current = vi.mocked(useConnectedAccountsByToolkit)('github')
      const expired = { ...defaultAccount, id: 'acc-X', displayName: 'Account acc-X', status: 'expired' }
      vi.mocked(useConnectedAccountsByToolkit).mockReturnValue({ ...current, data: { accounts: [expired] } } as any)
      renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
      await user.click(screen.getByRole('button', { name: 'Add New Account' }))

      const completionA = onOAuthCallback({ toolkit: 'github', connectionId: 'conn-A' })
      await act(async () => {})
      await user.click(screen.getByRole('button', { name: 'Reconnect' }))

      await act(async () => { finishComplete['conn-A'](); await completionA })
      expect(screen.getByRole('button', { name: 'Allow Access' })).toBeDisabled()
      expect(screen.queryByTestId('policy-editor')).toBeNull()
    })

    it('ignores a cancelled attempt that finishes in the external browser, and still claims the retry', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
        const { rerender } = renderWithProviders(<ConnectedAccountRequestItem {...defaultProps} />)
        await user.click(screen.getByRole('button', { name: 'Connect' }))
        await act(async () => { await vi.advanceTimersByTimeAsync(LOGIN_WINDOW_CANCEL_DELAY_MS) })
        await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
        // B's initiate request is held open: A's identity must already be gone.
        let releaseInitiate!: () => void
        initiateGate = new Promise((resolve) => { releaseInitiate = resolve })
        await user.click(screen.getByRole('button', { name: 'Connect' }))
        expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()

        // A finishes anyway, while B is still asking for its URL: refresh only.
        fakeLoginWindow.close.mockClear()
        const completionA = onOAuthCallback({ toolkit: 'github', connectionId: 'conn-A' })
        await act(async () => { finishComplete['conn-A'](); await completionA })
        expect(fakeLoginWindow.close).not.toHaveBeenCalled()
        expect(refetch).toHaveBeenCalledOnce()
        await act(async () => releaseInitiate())
        rerender(<ConnectedAccountRequestItem {...defaultProps} />)
        expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Allow Access' })).toBeDisabled()

        // B finishes: claimed and selected.
        const completionB = onOAuthCallback({ toolkit: 'github', connectionId: 'conn-B' })
        await act(async () => { finishComplete['conn-B'](); await completionB })
        expect(fakeLoginWindow.close).toHaveBeenCalled()
        rerender(<ConnectedAccountRequestItem {...defaultProps} />)
        expect(screen.getByRole('button', { name: 'Allow Access (1)' })).toBeEnabled()
      } finally {
        vi.useRealTimers()
      }
    })
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
