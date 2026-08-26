// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { InboundXAgentView } from './inbound-x-agent-view'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useDetails: vi.fn(),
  mutatePermission: vi.fn(),
  startViewTransition: vi.fn((callback: () => void) => callback()),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/hooks/use-inbound-x-agent', () => ({
  useInboundXAgentDetails: (...args: unknown[]) => mocks.useDetails(...args),
  useSetInboundXAgentPermission: () => ({ mutateAsync: mocks.mutatePermission }),
}))

vi.mock('@renderer/lib/view-transition', () => ({
  startViewTransition: (callback: () => void) => mocks.startViewTransition(callback),
}))

describe('InboundXAgentView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutatePermission.mockResolvedValue(undefined)
    mocks.useDetails.mockReturnValue({
      data: {
        sessions: [{
          id: 'session-a',
          createdAt: '2026-08-20T18:00:00.000Z',
          triggeredBy: { slug: 'caller-a', name: 'Caller A' },
        }],
        callers: [
          {
            slug: 'caller-a',
            displaySlug: 'caller-a-display',
            name: 'Caller A',
            decision: 'allow',
            canAccess: true,
          },
          {
            slug: 'caller-b',
            displaySlug: 'caller-b-display',
            name: 'Caller B',
            decision: 'review',
            canAccess: false,
          },
        ],
      },
      isLoading: false,
      error: null,
    })
  })

  it('shows a flat caller card split by automatic and approval decisions', () => {
    renderWithProviders(<InboundXAgentView agentSlug="target" />)

    expect(screen.getByText('Called from Other Agents')).toBeInTheDocument()
    expect(screen.getByText('Triggered by')).toBeInTheDocument()
    const card = screen.getByTestId('inbound-x-agent-callers-card')
    const automatic = within(card).getByTestId('automatic-callers-section')
    const approval = within(card).getByTestId('approval-callers-section')
    expect(within(automatic).getByText('Caller A')).toBeInTheDocument()
    expect(within(approval).getByText('Caller B')).toBeInTheDocument()
    expect(within(card).getByTestId('inbound-x-agent-toggle-caller-a'))
      .toHaveAttribute('aria-checked', 'true')
    expect(within(card).getByTestId('inbound-x-agent-toggle-caller-b'))
      .toHaveAttribute('aria-checked', 'false')
    expect(within(card).getByTestId('inbound-x-agent-toggle-caller-b')).toBeDisabled()

    // The section rows live directly in the one outer card; there is no nested
    // rounded/bordered IntegrationList box.
    expect(card.querySelectorAll('.rounded-xl.border')).toHaveLength(0)
  })

  it('opens the selected run', () => {
    renderWithProviders(<InboundXAgentView agentSlug="target" />)

    fireEvent.click(screen.getByRole('button', { name: 'Open call from Caller A' }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'target', sessionId: 'session-a' },
    })
  })

  it('persists a toggle and animates the row into the other section', async () => {
    renderWithProviders(<InboundXAgentView agentSlug="target" />)

    fireEvent.click(screen.getByTestId('inbound-x-agent-toggle-caller-a'))

    expect(mocks.startViewTransition).toHaveBeenCalled()
    expect(mocks.mutatePermission).toHaveBeenCalledWith({
      callerAgentSlug: 'caller-a',
      decision: 'review',
    })
    await waitFor(() => {
      expect(within(screen.getByTestId('approval-callers-section')).getByText('Caller A'))
        .toBeInTheDocument()
    })
    expect(screen.getByTestId('inbound-x-agent-toggle-caller-a'))
      .toHaveAttribute('aria-checked', 'false')
  })

  it('animates a failed permission change back to server state', async () => {
    mocks.mutatePermission.mockRejectedValueOnce(new Error('Permission denied'))
    renderWithProviders(<InboundXAgentView agentSlug="target" />)

    fireEvent.click(screen.getByTestId('inbound-x-agent-toggle-caller-a'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Permission denied')
    })
    expect(within(screen.getByTestId('automatic-callers-section')).getByText('Caller A'))
      .toBeInTheDocument()
    expect(mocks.startViewTransition).toHaveBeenCalledTimes(2)
  })
})
