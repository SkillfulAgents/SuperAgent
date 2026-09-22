// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountReauthRequestItem } from './account-reauth-request-item'

const mockReconnect = vi.fn()
const mockDismiss = vi.fn()
const mockCancelReconnect = vi.fn()
let mockPendingAccountId: string | null = null
let mockCanCancel = false
vi.mock('./connected-account-request-item', () => ({
  ConnectedAccountRequestItem: ({ toolkit, replacement }: { toolkit: string; replacement: { requestId: string; onCancel: () => void } }) => (
    <div data-testid="replacement-picker" data-toolkit={toolkit} data-request-id={replacement.requestId}>
      <button onClick={replacement.onCancel}>Cancel replacement</button>
    </div>
  ),
}))

let mockOwnedAccountIds = ['account-1', 'account-2', 'account-3']

vi.mock('@renderer/lib/reauth-dismiss', () => ({
  dismissReauthRequest: (...args: unknown[]) => mockDismiss(...args),
}))

vi.mock('@renderer/hooks/use-oauth-reconnect', () => ({
  useOAuthReconnect: () => ({
    reconnect: (...args: unknown[]) => mockReconnect(...args),
    pendingAccountId: mockPendingAccountId,
    canCancelPendingReconnect: mockCanCancel,
    cancelReconnect: mockCancelReconnect,
  }),
}))

vi.mock('@renderer/hooks/use-connected-accounts', () => ({
  useConnectedAccounts: () => ({
    data: { accounts: mockOwnedAccountIds.map((id) => ({ id })) },
  }),
}))

describe('AccountReauthRequestItem', () => {
  beforeEach(() => {
    mockReconnect.mockReset()
    mockDismiss.mockReset().mockResolvedValue(undefined)
    mockCancelReconnect.mockReset()
    mockPendingAccountId = null
    mockCanCancel = false
    mockOwnedAccountIds = ['account-1', 'account-2', 'account-3']
  })

  it('shows no failure when the user cancels, even once a retry is under way', async () => {
    // Each reconnect call settles only when the test says so, like a request
    // still in flight when Cancel lands.
    const settlers: Array<(succeeded: boolean) => void> = []
    mockReconnect.mockImplementation(() => new Promise<boolean>((resolve) => { settlers.push(resolve) }))
    const item = () => (
      <AccountReauthRequestItem
        proxyRequestId="proxy-2"
        accountId="account-2"
        toolkit="gmail"
        accountStatus="revoked"
        agentSlug="agent-1"
        onComplete={vi.fn()}
      />
    )
    const { rerender } = render(item())
    fireEvent.click(screen.getByTestId('account-reauth-reconnect-btn'))
    mockPendingAccountId = 'account-2'
    mockCanCancel = true
    rerender(item())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect(mockCancelReconnect).toHaveBeenCalledOnce()
    mockPendingAccountId = null
    mockCanCancel = false
    rerender(item())
    fireEvent.click(screen.getByTestId('account-reauth-reconnect-btn'))
    expect(settlers).toHaveLength(2)

    await act(async () => settlers[0](false))
    expect(screen.queryByText(/Reconnection was not completed/)).not.toBeInTheDocument()

    // Cancel the retry too, with nothing after it.
    mockPendingAccountId = 'account-2'
    mockCanCancel = true
    rerender(item())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    await act(async () => settlers[1](false))
    expect(screen.queryByText(/Reconnection was not completed/)).not.toBeInTheDocument()
  })

  it('explains the expired access and resumes after a successful reconnect', async () => {
    const onComplete = vi.fn()
    mockReconnect.mockResolvedValue(true)

    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-1"
        accountId="account-1"
        toolkit="gmail"
        accountStatus="expired"
        agentSlug="agent-1"
        onComplete={onComplete}
      />,
    )

    expect(screen.getByText('This request needs Gmail access that has expired.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('account-reauth-reconnect-btn'))

    await waitFor(() => expect(mockReconnect).toHaveBeenCalledWith('account-1', 'gmail'))
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('keeps the card open when reconnection is not completed', async () => {
    const onComplete = vi.fn()
    mockReconnect.mockResolvedValue(false)

    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-2"
        accountId="account-2"
        toolkit="gmail"
        accountStatus="revoked"
        agentSlug="agent-1"
        onComplete={onComplete}
      />,
    )

    fireEvent.click(screen.getByTestId('account-reauth-reconnect-btn'))

    expect(await screen.findByText(/Reconnection was not completed/)).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not render a reconnect action in read-only mode', () => {
    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-3"
        accountId="account-3"
        toolkit="gmail"
        accountStatus="expired"
        agentSlug="agent-1"
        readOnly
        onComplete={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('account-reauth-reconnect-btn')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for reconnection')).toBeInTheDocument()
  })

  it('lets a non-owner replace the connection and cancel back to the recovery card', () => {
    mockOwnedAccountIds = []
    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-4"
        accountId="account-4"
        toolkit="gmail"
        accountStatus="expired"
        agentSlug="agent-1"
        onComplete={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('account-reauth-reconnect-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('account-reauth-dismiss-btn')).toBeInTheDocument()
    expect(screen.getByText(/Replace it with an account you own/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('account-reauth-replace-btn'))
    expect(screen.getByTestId('replacement-picker')).toHaveAttribute('data-toolkit', 'gmail')
    expect(screen.getByTestId('replacement-picker')).toHaveAttribute('data-request-id', 'proxy-4')
    fireEvent.click(screen.getByText('Cancel replacement'))
    expect(screen.getByTestId('account-reauth-dismiss-btn')).toBeInTheDocument()
    expect(mockReconnect).not.toHaveBeenCalled()
    expect(mockDismiss).not.toHaveBeenCalled()
  })

  it('dismisses the parked request and closes the card', async () => {
    const onComplete = vi.fn()
    mockOwnedAccountIds = []

    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-5"
        accountId="account-5"
        toolkit="gmail"
        accountStatus="expired"
        agentSlug="agent-1"
        onComplete={onComplete}
      />,
    )

    fireEvent.click(screen.getByTestId('account-reauth-dismiss-btn'))

    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({
      agentSlug: 'agent-1',
      requestId: 'proxy-5',
      reason: undefined,
    }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
  })

  it('keeps the card open when the dismissal fails', async () => {
    const onComplete = vi.fn()
    mockOwnedAccountIds = []
    mockDismiss.mockRejectedValue(new Error('Request not found'))

    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-6"
        accountId="account-6"
        toolkit="gmail"
        accountStatus="expired"
        agentSlug="agent-1"
        onComplete={onComplete}
      />,
    )

    fireEvent.click(screen.getByTestId('account-reauth-dismiss-btn'))

    expect(await screen.findByText(/Request not found/)).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('offers no dismissal in read-only mode', () => {
    render(
      <AccountReauthRequestItem
        proxyRequestId="proxy-7"
        accountId="account-1"
        toolkit="gmail"
        accountStatus="expired"
        agentSlug="agent-1"
        readOnly
        onComplete={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('account-reauth-dismiss-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('account-reauth-replace-btn')).not.toBeInTheDocument()
  })
})
