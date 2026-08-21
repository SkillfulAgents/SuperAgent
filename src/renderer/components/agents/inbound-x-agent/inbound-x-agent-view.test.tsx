// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { InboundXAgentView } from './inbound-x-agent-view'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useDetails: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/hooks/use-inbound-x-agent', () => ({
  useInboundXAgentDetails: (...args: unknown[]) => mocks.useDetails(...args),
}))

describe('InboundXAgentView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('shows history and greys callers the viewer cannot access', () => {
    renderWithProviders(<InboundXAgentView agentSlug="target" />)

    expect(screen.getByText('Called from Other Agents')).toBeInTheDocument()
    expect(screen.getByText('Triggered by')).toBeInTheDocument()
    expect(screen.getByText('Approval required · No access').closest('[aria-disabled="true"]'))
      .toHaveTextContent('Caller B')
    expect(screen.getByRole('button', { name: 'Open Caller A' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Caller B/ })).not.toBeInTheDocument()
  })

  it('opens the selected run and accessible caller agent', () => {
    renderWithProviders(<InboundXAgentView agentSlug="target" />)

    fireEvent.click(screen.getByRole('button', { name: 'Open call from Caller A' }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'target', sessionId: 'session-a' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Open Caller A' }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'caller-a-display' },
    })
  })
})
