// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { CompletedTasksView } from './completed-tasks-view'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  useCompletedSessions: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useCompletedOneTimeSessions: (...args: unknown[]) => mocks.useCompletedSessions(...args),
}))

vi.mock('@renderer/components/sessions/related-sessions', () => ({
  RelatedSessions: ({ sessions }: { sessions: Array<{ id: string; name: string }> }) => (
    <div data-testid="completed-session-list">
      {sessions.map((session) => <span key={session.id}>{session.name}</span>)}
    </div>
  ),
}))

describe('CompletedTasksView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useCompletedSessions.mockReturnValue({
      data: [
        { id: 'session-a', name: 'TikTok audit — Aug 24', createdAt: '2026-08-24T12:00:00.000Z' },
        { id: 'session-b', name: 'TikTok audit — Aug 25', createdAt: '2026-08-25T12:00:00.000Z' },
      ],
      isLoading: false,
      error: null,
    })
  })

  it('lists completed one-time sessions and returns to the agent home', () => {
    renderWithProviders(<CompletedTasksView agentSlug="agent-a" />)

    expect(mocks.useCompletedSessions).toHaveBeenCalledWith('agent-a')
    expect(screen.getByText('Completed One-time Tasks')).toBeInTheDocument()
    expect(screen.getByText('Sessions (2)')).toBeInTheDocument()
    expect(screen.getByText('TikTok audit — Aug 24')).toBeInTheDocument()
    expect(screen.getByText('TikTok audit — Aug 25')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('completed-tasks-back-button'))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'agent-a' },
    })
  })

  it('shows an empty state when no completed sessions remain', () => {
    mocks.useCompletedSessions.mockReturnValue({ data: [], isLoading: false, error: null })

    renderWithProviders(<CompletedTasksView agentSlug="agent-a" />)

    expect(screen.getByText('No completed one-time sessions yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('completed-session-list')).not.toBeInTheDocument()
  })
})
