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
  session: {
    id: 'x-session',
    agentSlug: 'target-agent',
    name: 'Invoked by Caller Agent',
    invokedByAgentSlug: 'caller-agent',
    invokedByAgentName: 'Caller Agent',
    unreadMentionMessageUuid: null as string | null,
  },
  jump: null as {
    jumpToMessageId?: string | null
    onJumpSettled?: (result: 'scrolled' | 'unmounted') => void
  } | null,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSession: () => ({
    data: mocks.session,
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
vi.mock('./session-chat-column', () => ({
  SessionChatColumn: (props: {
    jumpToMessageId?: string | null
    onJumpSettled?: (result: 'scrolled' | 'unmounted') => void
  }) => {
    mocks.jump = props
    return null
  },
}))
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
    mocks.session.unreadMentionMessageUuid = null
    mocks.jump = null
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

  it('with an unread mention, marks read only after the jump settles, and not on visibilitychange before that', () => {
    mocks.session.unreadMentionMessageUuid = 'm1'
    render(<SessionView agentSlug="target-agent" sessionId="x-session" />)
    expect(mocks.markRead).not.toHaveBeenCalled()
    fireEvent(document, new Event('visibilitychange'))
    expect(mocks.markRead).not.toHaveBeenCalled()
    mocks.jump?.onJumpSettled?.('scrolled')
    expect(mocks.markRead).toHaveBeenCalledWith('x-session')
  })

  it('jumps from an inbox mention even when the session mention is already read', () => {
    mocks.session.unreadMentionMessageUuid = null
    render(<SessionView agentSlug="target-agent" sessionId="x-session" inboxMessageUuid="m-inbox" />)
    expect(mocks.jump?.jumpToMessageId).toBe('m-inbox')
    expect(mocks.markRead).not.toHaveBeenCalled()
    mocks.jump?.onJumpSettled?.('scrolled')
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'target-agent', sessionId: 'x-session' },
      search: {},
      replace: true,
    })
    expect(mocks.markRead).toHaveBeenCalledWith('x-session')
  })
})

describe('SessionView x-agent provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clearUnread.mockReturnValue(false)
    mocks.session.unreadMentionMessageUuid = null
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
