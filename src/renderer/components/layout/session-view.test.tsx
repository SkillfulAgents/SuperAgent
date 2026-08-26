// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionView } from './session-view'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  markRead: vi.fn(),
  setMarkedUnread: vi.fn(),
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

describe('SessionView x-agent provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
