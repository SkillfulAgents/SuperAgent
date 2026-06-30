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
// TrayManager pulls in the sidebar/browser world; the composer-swap logic doesn't need it.
vi.mock('@renderer/components/tray/tray-manager', () => ({
  TrayManager: () => null,
}))

// usePendingRequests is the lever this test pulls.
const mockPendingResult = {
  items: [] as PendingRequestDescriptor[],
  count: 0,
}
vi.mock('@renderer/components/messages/use-pending-requests', () => ({
  usePendingRequests: () => mockPendingResult,
}))

// useMessageStream — SessionChatColumn reads `isActive` and `browserActive`.
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ isActive: false, browserActive: false }),
}))

const baseProps = {
  sessionId: 's-1',
  agentSlug: 'agent-1',
  pendingUserMessages: [],
  isViewOnly: false,
  contextPercent: null,
  onPendingMessageAppeared: () => {},
  onMessageSent: () => {},
  onMessageUuidAssigned: () => {},
  onMessageFailed: () => {},
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

// Detection logic lives in useStaleSession (unit-tested there). This just verifies
// SessionChatColumn wires showToast → the toast in the at-rest footer.
describe('SessionChatColumn stale toast', () => {
  const staleProps = {
    ...baseProps,
    lastActivityAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    contextUsage: {
      inputTokens: 5000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 130_000,
      contextWindow: 200_000,
    },
  }

  beforeEach(() => {
    mockPendingResult.items = []
    mockPendingResult.count = 0
  })

  it('renders the stale toast when the conversation is idle + large, at rest', () => {
    renderWithProviders(<SessionChatColumn {...staleProps} />)
    expect(screen.getByTestId('stale-toast')).toBeInTheDocument()
    expect(screen.getByTestId('stale-new-chat')).toBeInTheDocument()
  })

  it('does not render the stale toast for a fresh conversation', () => {
    renderWithProviders(<SessionChatColumn {...baseProps} />)
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()
  })

  it('does not render the stale toast while a request is pending', () => {
    mockPendingResult.items = [secretDescriptor]
    mockPendingResult.count = 1
    renderWithProviders(<SessionChatColumn {...staleProps} />)
    expect(screen.queryByTestId('stale-toast')).not.toBeInTheDocument()
  })
})
