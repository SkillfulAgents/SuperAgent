// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionView } from './session-view'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  markRead: vi.fn(),
  setMarkedUnread: vi.fn(),
  // Reports whether a dot was actually showing; defaults to the common no-op open.
  clearUnread: vi.fn(() => false),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSession: () => ({
    data: {
      id: 'x-session',
      agentSlug: 'target-agent',
      name: 'Invoked by Caller Agent',
      invokedByAgentSlug: 'caller-agent',
      invokedByAgentName: 'Caller Agent',
    },
    error: null,
  }),
  // Opening a session clears any "mark as unread" flag alongside the
  // notification read-marking below.
  useSetSessionMarkedUnread: () => ({ mutate: mocks.setMarkedUnread }),
  useClearSessionUnread: () => mocks.clearUnread,
}))

vi.mock('@renderer/hooks/use-notifications', () => ({
  useMarkSessionNotificationsRead: () => ({ mutate: mocks.markRead }),
}))

vi.mock('@renderer/context/pending-messages-context', () => ({
  usePendingMessages: () => ({
    getPendingMessages: () => [],
    onMessageSent: vi.fn(),
    onMessageUuidAssigned: vi.fn(),
    onPendingMessageAppeared: vi.fn(),
    streamContextUsage: null,
  }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => true }),
}))

vi.mock('@renderer/lib/perf', () => ({ useRenderTracker: () => {} }))
vi.mock('@renderer/hooks/use-session-search', () => ({ useSessionSearch: () => ({}) }))
vi.mock('@renderer/components/messages/session-search-bar', () => ({
  SessionSearchBar: () => null,
}))
vi.mock('./session-chat-column', () => ({ SessionChatColumn: () => null }))
vi.mock('@renderer/context/file-preview-context', () => ({
  FilePreviewProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@renderer/context/workflow-context', () => ({
  WorkflowProvider: ({ children }: { children: ReactNode }) => children,
}))

describe('SessionView unread clearing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearUnread.mockReturnValue(false)
  })

  it('takes the dot down in the caches on mount and writes through immediately', () => {
    mocks.clearUnread.mockReturnValue(true)
    render(<SessionView agentSlug="target-agent" sessionId="x-session" />)

    expect(mocks.clearUnread).toHaveBeenCalledWith('target-agent', 'x-session')
    // A dot that was actually showing must not be able to come back on the next
    // refetch, so its write does not wait out the quick-navigation debounce.
    expect(mocks.markRead).toHaveBeenCalledWith('x-session')
    expect(mocks.setMarkedUnread).toHaveBeenCalledWith({
      sessionId: 'x-session',
      agentSlug: 'target-agent',
      markedUnread: false,
    })
  })

  it('keeps the debounce for an open with no dot showing', () => {
    vi.useFakeTimers()
    try {
      render(<SessionView agentSlug="target-agent" sessionId="x-session" />)

      expect(mocks.markRead).not.toHaveBeenCalled()
      expect(mocks.setMarkedUnread).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(mocks.markRead).toHaveBeenCalledWith('x-session')
      expect(mocks.setMarkedUnread).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionView x-agent provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearUnread.mockReturnValue(false)
  })

  it('shows the Back bar and returns to Called from Other Agents', () => {
    render(<SessionView agentSlug="target-agent" sessionId="x-session" />)

    expect(screen.getByTestId('x-agent-session-banner')).toHaveTextContent(
      'Session created by x-agent call from "Caller Agent"',
    )
    fireEvent.click(screen.getByTestId('x-agent-session-back-button'))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/called-from-agents',
      params: { slug: 'target-agent' },
    })
  })
})
