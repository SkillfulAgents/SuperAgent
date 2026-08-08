// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccountReauthRequestItem } from './account-reauth-request-item'

const mockReconnect = vi.fn()
let mockPendingAccountId: string | null = null

vi.mock('@renderer/hooks/use-oauth-reconnect', () => ({
  useOAuthReconnect: () => ({
    reconnect: (...args: unknown[]) => mockReconnect(...args),
    pendingAccountId: mockPendingAccountId,
  }),
}))

describe('AccountReauthRequestItem', () => {
  beforeEach(() => {
    mockReconnect.mockReset()
    mockPendingAccountId = null
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
})
