// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationStatusCard } from './integration-status-card'
import { makeChatIntegration as makeIntegration } from './test-factories'

const updateMock = vi.fn()
vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useUpdateAgentIntegration: () => ({ mutate: updateMock, isPending: false }),
}))

describe('IntegrationStatusCard', () => {
  beforeEach(() => { updateMock.mockReset() })

  // Error is still an "on" state — its switch offers to pause, like the live ones.
  it.each([
    { status: 'active' as const, connected: true, expectedLabel: 'Listening', expectedSwitch: /pause integration/i },
    { status: 'active' as const, connected: false, expectedLabel: 'Connecting…', expectedSwitch: /pause integration/i },
    { status: 'paused' as const, connected: false, expectedLabel: 'Paused', expectedSwitch: /resume integration/i },
    { status: 'error' as const, connected: false, expectedLabel: 'Error', expectedSwitch: /pause integration/i },
  ])('shows the $expectedLabel state', ({ status, connected, expectedLabel, expectedSwitch }) => {
    render(<IntegrationStatusCard integration={makeIntegration({ status })} connected={connected} />)
    expect(screen.getByText(expectedLabel)).toBeInTheDocument()
    expect(screen.getByLabelText(expectedSwitch)).toBeInTheDocument()
  })

  it('shows reconnect needed instead of offering to resume revoked credentials', () => {
    render(<IntegrationStatusCard integration={makeIntegration({ status: 'disconnected', hasCredentials: false, reconnectRequired: true })} connected={false} />)
    expect(screen.getByText('Reconnect needed')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
  })

  it('pauses when toggled off', async () => {
    const user = userEvent.setup()
    render(<IntegrationStatusCard integration={makeIntegration({ status: 'active' })} connected />)
    await user.click(screen.getByLabelText(/pause integration/i))
    expect(updateMock).toHaveBeenCalledWith({ id: 'int-1', status: 'paused' })
  })

  it('resumes when toggled on', async () => {
    const user = userEvent.setup()
    render(<IntegrationStatusCard integration={makeIntegration({ status: 'paused' })} />)
    await user.click(screen.getByLabelText(/resume integration/i))
    expect(updateMock).toHaveBeenCalledWith({ id: 'int-1', status: 'active' })
  })
  it('allows pausing damaged credentials but prevents resuming them', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<IntegrationStatusCard integration={makeIntegration({ status: 'error', hasCredentials: false })} />)
    await user.click(screen.getByLabelText(/pause integration/i))
    expect(updateMock).toHaveBeenCalledWith({ id: 'int-1', status: 'paused' })
    rerender(<IntegrationStatusCard integration={makeIntegration({ status: 'paused', hasCredentials: false })} />)
    expect(screen.getByRole('switch')).toBeDisabled()
  })

})
