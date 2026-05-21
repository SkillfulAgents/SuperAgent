// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { SessionChatColumn } from './session-chat-column'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { PendingRequestDescriptor } from '@renderer/components/messages/use-pending-requests'

// Mock children so we don't pull in the world; just mark them with testids.
vi.mock('@renderer/components/messages/message-list', () => ({
  MessageList: ({ pendingRequestCount }: { pendingRequestCount?: number }) => (
    <div data-testid="message-list" data-pending-count={pendingRequestCount} />
  ),
}))
vi.mock('@renderer/components/messages/message-input', () => ({
  MessageInput: () => <div data-testid="message-input-mock" />,
}))
vi.mock('@renderer/components/messages/agent-activity-indicator', () => ({
  AgentActivityIndicator: () => null,
}))
vi.mock('@renderer/components/messages/pending-request-stack', () => ({
  PendingRequestStack: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pending-request-stack">{children}</div>
  ),
}))
vi.mock('@renderer/components/messages/pending-request-renderer', () => ({
  renderPendingRequest: (d: PendingRequestDescriptor) => (
    <div key={d.key} data-testid={`pending-${d.kind}`} data-key={d.key} />
  ),
}))

// usePendingRequests is the lever this test pulls.
const mockPendingResult = {
  items: [] as PendingRequestDescriptor[],
  count: 0,
}
vi.mock('@renderer/components/messages/use-pending-requests', () => ({
  usePendingRequests: () => mockPendingResult,
}))

// useMessageStream — only `isActive` is read by SessionChatColumn.
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ isActive: false }),
}))

const baseProps = {
  sessionId: 's-1',
  agentSlug: 'agent-1',
  pendingUserMessage: null,
  isViewOnly: false,
  contextPercent: null,
  onPendingMessageAppeared: () => {},
  onMessageSent: () => {},
}

const noop = () => {}

const secretDescriptor: PendingRequestDescriptor = {
  kind: 'secret',
  key: 'tu-1',
  toolUseId: 'tu-1',
  secretName: 'A',
  onComplete: noop,
}
const fileDescriptor: PendingRequestDescriptor = {
  kind: 'file',
  key: 'tu-2',
  toolUseId: 'tu-2',
  description: 'pick',
  onComplete: noop,
}

describe('SessionChatColumn composer swap', () => {
  beforeEach(() => {
    mockPendingResult.items = []
    mockPendingResult.count = 0
  })

  it('renders MessageInput when there are no pending requests', () => {
    renderWithProviders(<SessionChatColumn {...baseProps} />)
    expect(screen.getByTestId('message-input-mock')).toBeInTheDocument()
    expect(screen.queryByTestId('pending-request-stack')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pending-request-slot')).not.toBeInTheDocument()
  })

  it('replaces MessageInput with PendingRequestStack when a request is pending', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    expect(screen.queryByTestId('message-input-mock')).not.toBeInTheDocument()
    expect(screen.getByTestId('pending-request-slot')).toBeInTheDocument()
    expect(screen.getByTestId('pending-request-stack')).toBeInTheDocument()
    expect(screen.getByTestId('pending-secret')).toBeInTheDocument()
  })

  it('renders multiple descriptors inside the stack in arrival order', () => {
    mockPendingResult.items = [secretDescriptor, fileDescriptor]
    mockPendingResult.count = 2

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    const stack = screen.getByTestId('pending-request-stack')
    const children = stack.querySelectorAll('[data-testid^="pending-"]')
    expect(children).toHaveLength(2)
    expect(children[0].getAttribute('data-key')).toBe('tu-1')
    expect(children[1].getAttribute('data-key')).toBe('tu-2')
  })

  it('forwards pendingRequestCount to MessageList for scroll-trigger purposes', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    expect(screen.getByTestId('message-list').getAttribute('data-pending-count')).toBe('1')
  })

  it('shows the keyboard hint footer only when no request is pending', () => {
    // No pending → footer shown
    renderWithProviders(<SessionChatColumn {...baseProps} />)
    expect(screen.getByText('Send')).toBeInTheDocument()
    expect(screen.getByText('New line')).toBeInTheDocument()
  })

  it('hides the keyboard hint footer when a request is pending', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1

    renderWithProviders(<SessionChatColumn {...baseProps} />)

    expect(screen.queryByText('Send')).not.toBeInTheDocument()
    expect(screen.queryByText('New line')).not.toBeInTheDocument()
  })
})
