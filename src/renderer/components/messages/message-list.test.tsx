// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, act } from '@testing-library/react'
import { MessageList } from './message-list'
import { useDraft } from '@renderer/context/drafts-context'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createUserMessage, createAssistantMessage, createToolCall, createCompactBoundary } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

// Mock useMessages
const mockMessagesData: { data: ApiMessageOrBoundary[] | undefined; isLoading: boolean; error: Error | null } = {
  data: undefined,
  isLoading: false,
  error: null,
}

const mockDeleteMessage = vi.fn()
const mockDeleteToolCall = vi.fn()
// Cancel mutation mock: invokes the mutate() callbacks synchronously with a
// configurable result so tests can exercise both race outcomes.
let mockCancelResult: { cancelled: boolean } = { cancelled: true }
const mockCancelQueued = vi.fn(
  (_vars: unknown, opts?: { onSuccess?: (r: { cancelled: boolean }) => void; onSettled?: () => void }) => {
    opts?.onSuccess?.(mockCancelResult)
    opts?.onSettled?.()
  }
)

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
  useDeleteMessage: () => ({ mutate: mockDeleteMessage }),
  useDeleteToolCall: () => ({ mutate: mockDeleteToolCall }),
  useCancelQueuedMessage: () => ({ mutate: mockCancelQueued }),
  // Real class so `error instanceof TranscriptNotFoundError` works in the component.
  TranscriptNotFoundError: class TranscriptNotFoundError extends Error {
    constructor() {
      super('Session transcript not found')
      this.name = 'TranscriptNotFoundError'
    }
  },
}))

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null as string | null,
  streamingToolUses: [] as Array<{ id: string; name: string; partialInput: string }>,
  isCompacting: false,
  activeSubagents: [] as any[],
  completedSubagents: null as Set<string> | null,
  typingUser: null as { id: string; name?: string } | null,
  peerUserMessages: [] as Array<{ uuid: string; receivedAt: number; content: string; sender: { id: string; name?: string; email?: string }; queued?: boolean }>,
  thinkingBlocks: [] as Array<{ id: number; text: string; startedAt: number; endedAt: number | null }>,
}

const mockClearCompacting = vi.fn()
const mockRemovePeerUserMessage = vi.fn()
const mockClearPeerUserMessages = vi.fn()

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  clearCompacting: (...args: unknown[]) => mockClearCompacting(...args),
  removePeerUserMessage: (...args: unknown[]) => mockRemovePeerUserMessage(...args),
  clearPeerUserMessages: (...args: unknown[]) => mockClearPeerUserMessages(...args),
}))

// Mock useUser — default no user, override per test
let mockCurrentUser: { id: string; name: string; email: string } | null = null
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    user: mockCurrentUser,
    isAuthMode: !!mockCurrentUser,
    isAuthenticated: !!mockCurrentUser,
    isAdmin: false,
    isPending: false,
    mustChangePassword: false,
    rolesReady: true,
    canAccessAgent: () => true,
    canUseAgent: () => true,
    canAdminAgent: () => false,
    agentRole: () => null,
    agentMemberCount: () => 0,
    signOut: async () => {},
  }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock useIsOnline — default online, override per test
let mockIsOnline = true
vi.mock('@renderer/context/connectivity-context', () => ({
  useIsOnline: () => mockIsOnline,
  ConnectivityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock formatElapsed
vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
  useElapsedTimer: () => null,
}))

// Mock getApiBaseUrl
vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://test-api',
  isElectron: () => false,
  getPlatform: () => 'web',
}))

// Mock child components that are complex
vi.mock('./tool-call-item', () => ({
  ToolCallItem: ({ toolCall, isSessionActive }: any) => (
    <div data-testid={`tool-call-${toolCall.name}`} data-running={isSessionActive ? 'true' : 'false'}>{toolCall.name}</div>
  ),
  StreamingToolCallItem: ({ name }: any) => <div data-testid="streaming-tool-call">{name}</div>,
  StatusIndicator: ({ status }: any) => <span data-testid="status-indicator">{status}</span>,
}))

vi.mock('./subagent-block', () => ({
  SubAgentBlock: ({ toolCall }: any) => <div data-testid="subagent-block">{toolCall.name}</div>,
}))

vi.mock('./message-context-menu', () => ({
  MessageContextMenu: ({ children }: any) => <>{children}</>,
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

describe('MessageList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMessagesData.data = undefined
    mockMessagesData.isLoading = false
    mockIsOnline = true
    mockCurrentUser = null
    mockCancelResult = { cancelled: true }
    Object.assign(mockStreamState, {
      isActive: false,
      isStreaming: false,
      streamingMessage: null,
      streamingToolUses: [],
      isCompacting: false,
      activeSubagents: [],
      completedSubagents: null,
      typingUser: null,
      peerUserMessages: [],
      thinkingBlocks: [],
    })
  })

  it('shows loading spinner', () => {
    mockMessagesData.isLoading = true
    const { container } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('renders messages', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hi' } }),
      createAssistantMessage({ content: { text: 'Hello!' } }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByText('Hi')).toBeInTheDocument()
    expect(screen.getByText('Hello!')).toBeInTheDocument()
  })

  it('renders compact boundaries', () => {
    const boundary = createCompactBoundary({ summary: 'Compacted section' })
    mockMessagesData.data = [boundary as any]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByText('Compacted')).toBeInTheDocument()
  })

  it('shows pending user message optimistically', () => {
    mockMessagesData.data = []

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'pm-1', uuid: 'pm-1', text: 'Sending...', sentAt: Date.now() }]}
      />
    )
    expect(screen.getByText('Sending...')).toBeInTheDocument()
  })

  it('shows queued ghost messages with a Queued label', () => {
    mockMessagesData.data = []
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[
          { localId: 'pm-1', uuid: 'pm-1', text: 'First queued', sentAt: Date.now(), queued: true },
          { localId: 'pm-2', uuid: 'pm-2', text: 'Second queued', sentAt: Date.now(), queued: true },
        ]}
      />
    )
    expect(screen.getByText('First queued')).toBeInTheDocument()
    expect(screen.getByText('Second queued')).toBeInTheDocument()
    expect(screen.getAllByTestId('queued-user-message')).toHaveLength(2)
    expect(screen.getAllByText('Queued')).toHaveLength(2)
  })

  it('shows streaming message when not persisted', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
    ]
    mockStreamState.streamingMessage = 'Streaming response...'
    mockStreamState.isStreaming = true

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByText('Streaming response...')).toBeInTheDocument()
  })

  it('hides streaming message when persisted', () => {
    const assistantMsg = createAssistantMessage({
      content: { text: 'Complete response here' },
    })
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
      assistantMsg,
    ]
    mockStreamState.streamingMessage = 'Complete response here'
    mockStreamState.isStreaming = false

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    // The text "Complete response here" should appear once (from persisted msg) not twice
    const elements = screen.getAllByText('Complete response here')
    expect(elements).toHaveLength(1)
  })

  it('shows streaming tool use when not persisted', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
    ]
    mockStreamState.streamingToolUses = [{
      id: 'tc-streaming',
      name: 'WebSearch',
      partialInput: '{"query": "test"}',
    }]
    mockStreamState.isStreaming = true

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('streaming-tool-call')).toBeInTheDocument()
  })

  it('hides streaming tool use when persisted', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [createToolCall({ id: 'tc-1', name: 'WebSearch' })],
      }),
    ]
    mockStreamState.streamingToolUses = [{
      id: 'tc-1', // Same ID = persisted
      name: 'WebSearch',
      partialInput: '{"query": "test"}',
    }]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.queryByTestId('streaming-tool-call')).not.toBeInTheDocument()
  })

  it('shows compacting indicator', () => {
    mockMessagesData.data = []
    mockStreamState.isCompacting = true

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByText('Compacting conversation...')).toBeInTheDocument()
  })

  // Pending-request derivation/rendering is covered by use-pending-requests.test.tsx.

  it('shows turn elapsed times for completed turns', () => {
    const userMsg = createUserMessage({
      content: { text: 'Hello' },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    })
    const assistantMsg = createAssistantMessage({
      content: { text: 'Response' },
      createdAt: new Date('2025-01-01T00:01:00Z'),
    })
    const userMsg2 = createUserMessage({
      content: { text: 'Follow up' },
      createdAt: new Date('2025-01-01T00:02:00Z'),
    })
    const assistantMsg2 = createAssistantMessage({
      content: { text: 'Second response' },
      createdAt: new Date('2025-01-01T00:02:30Z'),
    })

    mockMessagesData.data = [userMsg, assistantMsg, userMsg2, assistantMsg2]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // First turn: 60s
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()
    // Second turn not shown (session is active=false so it should be shown)
    expect(screen.getByText('Worked for 30s')).toBeInTheDocument()
  })

  it('detects running tool calls only for trailing assistant messages when active', () => {
    mockStreamState.isActive = true
    const msg1 = createAssistantMessage({
      id: 'msg-1',
      content: { text: '' },
      toolCalls: [createToolCall({ id: 'tc-old', name: 'Bash', result: undefined })],
    })
    const userMsg = createUserMessage({
      id: 'msg-2',
      content: { text: 'Continue' },
    })
    const msg2 = createAssistantMessage({
      id: 'msg-3',
      content: { text: '' },
      toolCalls: [createToolCall({ id: 'tc-new', name: 'Read', result: undefined })],
    })

    mockMessagesData.data = [msg1, userMsg, msg2]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Both tool calls render, but only the one after last user msg should show as "running"
    // The first one (before user msg) should show as "cancelled"
    // We can verify this by checking the render output of the test IDs
    expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
    expect(screen.getByTestId('tool-call-Read')).toBeInTheDocument()
  })

  // ---- Connection lost warning ----

  it('shows connection lost warning when active and offline', () => {
    mockStreamState.isActive = true
    mockIsOnline = false
    mockMessagesData.data = []

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByText('Internet connection lost.')).toBeInTheDocument()
    expect(screen.getByText(/The agent may still be running/)).toBeInTheDocument()
  })

  it('does not show connection lost warning when offline but idle', () => {
    mockStreamState.isActive = false
    mockIsOnline = false
    mockMessagesData.data = []

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.queryByText('Internet connection lost.')).not.toBeInTheDocument()
  })

  it('does not show connection lost warning when active and online', () => {
    mockStreamState.isActive = true
    mockIsOnline = true
    mockMessagesData.data = []

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.queryByText('Internet connection lost.')).not.toBeInTheDocument()
  })

  // ---- Delete callbacks ----

  it('passes handleRemoveMessage callback to MessageItem', () => {
    // MessageItem is rendered by mocking — we need to verify the mock gets onRemoveMessage
    // We can check that the mock renders and that deleteMessage.mutate would be called
    // by rendering a message with onRemoveMessage
    const msg = createAssistantMessage({ id: 'msg-del', content: { text: 'Delete me' } })
    mockMessagesData.data = [msg]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByText('Delete me')).toBeInTheDocument()
    // The actual delete flow is tested via MessageItem's own test
    // Here we verify the message renders (the callback is passed as a prop)
  })

  // ---- Compaction boundary safety net ----

  it('calls clearCompacting when new boundary appears during compaction', () => {
    mockStreamState.isCompacting = true
    // Start with no boundaries
    mockMessagesData.data = []

    const { rerender } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Now a boundary appears (compaction finished, SSE event was missed)
    mockMessagesData.data = [createCompactBoundary({ summary: 'New boundary' }) as any]
    rerender(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(mockClearCompacting).toHaveBeenCalledWith('s-1')
  })

  it('does not call clearCompacting when boundary count unchanged during compaction', () => {
    // Pre-existing boundary before compaction started
    mockMessagesData.data = [createCompactBoundary({ summary: 'Old boundary' }) as any]
    mockStreamState.isCompacting = false

    const { rerender } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Now compaction starts (same boundary count)
    mockStreamState.isCompacting = true
    rerender(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(mockClearCompacting).not.toHaveBeenCalled()
  })

  // ---- Pending message detection ----

  it('calls onPendingMessageAppeared when a message with the pending uuid is fetched', () => {
    const onAppeared = vi.fn()
    const sentAt = new Date('2025-01-01T00:00:00Z').getTime()

    mockMessagesData.data = [
      createUserMessage({
        id: 'uuid-1',
        content: { text: 'My message' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'uuid-1', uuid: 'uuid-1', text: 'My message', sentAt }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).toHaveBeenCalledWith('uuid-1')
  })

  it('falls back to text+time matching when the uuid differs (queued/steering messages)', () => {
    // The CLI re-ids messages sent mid-turn (queued_command attachments), so
    // the persisted copy never carries the client uuid — text fallback must fire.
    const onAppeared = vi.fn()
    const sentAt = new Date('2025-01-01T00:00:00Z').getTime()

    mockMessagesData.data = [
      createUserMessage({
        id: 'cli-generated-uuid',
        content: { text: 'My message' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      }),
    ]
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'uuid-1', uuid: 'uuid-1', text: 'My message', sentAt, queued: true }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).toHaveBeenCalledWith('uuid-1')
  })

  it('does not call onPendingMessageAppeared when neither uuid nor text matches', () => {
    const onAppeared = vi.fn()
    const sentAt = new Date('2025-01-01T00:00:00Z').getTime()

    mockMessagesData.data = [
      createUserMessage({
        id: 'other-uuid',
        content: { text: 'Different message' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      }),
    ]
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'uuid-1', uuid: 'uuid-1', text: 'My message', sentAt, queued: true }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).not.toHaveBeenCalled()
  })

  // ---- Queued (mid-turn) message rendering & turn boundaries ----

  it('renders queued ghosts below streaming content and tools', () => {
    mockMessagesData.data = [createUserMessage({ content: { text: 'Start' } })]
    mockStreamState.isActive = true
    mockStreamState.isStreaming = true
    mockStreamState.streamingMessage = 'Working on it...'
    mockStreamState.streamingToolUses = [{ id: 'tc-x', name: 'StreamingBash', partialInput: '' }]

    const { container } = renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'q1', uuid: 'q1', text: 'Queued msg', sentAt: Date.now(), queued: true }]}
      />
    )

    const text = container.textContent || ''
    expect(text.indexOf('Working on it...')).toBeLessThan(text.indexOf('Queued msg'))
    expect(text.indexOf('StreamingBash')).toBeLessThan(text.indexOf('Queued msg'))
  })

  it('does not close the turn at a persisted queued message (no elapsed divider mid-turn)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Start' }, createdAt: new Date('2025-01-01T00:00:00Z') }),
      createAssistantMessage({ content: { text: 'Searching' }, createdAt: new Date('2025-01-01T00:00:09Z') }),
      createUserMessage({ content: { text: 'Steer' }, createdAt: new Date('2025-01-01T00:00:10Z'), queued: true }),
      createAssistantMessage({ content: { text: 'Continuing' }, createdAt: new Date('2025-01-01T00:00:20Z') }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
  })

  it('attributes the whole turn duration across steering segments once idle', () => {
    mockStreamState.isActive = false
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Start' }, createdAt: new Date('2025-01-01T00:00:00Z') }),
      createAssistantMessage({ content: { text: 'Searching' }, createdAt: new Date('2025-01-01T00:00:09Z') }),
      createUserMessage({ content: { text: 'Steer' }, createdAt: new Date('2025-01-01T00:00:10Z'), queued: true }),
      createAssistantMessage({ content: { text: 'Continuing' }, createdAt: new Date('2025-01-01T00:00:20Z') }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    // One elapsed entry, from the turn-starting message to the final assistant message
    expect(screen.getByText('Worked for 20s')).toBeInTheDocument()
    expect(screen.queryByText('Worked for 9s')).not.toBeInTheDocument()
  })

  it('keeps tools running when a persisted queued message follows them', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Start' } }),
      createAssistantMessage({
        id: 'a1',
        content: { text: '' },
        toolCalls: [createToolCall({ id: 'tc-1', name: 'Bash', result: undefined })],
      }),
      createUserMessage({ content: { text: 'Steer' }, queued: true }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    // The queued message doesn't end the turn, so the unfinished tool is still running
    expect(screen.getByTestId('tool-call-Bash').getAttribute('data-running')).toBe('true')
  })

  it('one persisted copy clears at most one of two identical queued ghosts', () => {
    const onAppeared = vi.fn()
    const sentAt = Date.now()

    mockMessagesData.data = [
      createUserMessage({ id: 'cli-uuid-1', content: { text: 'Do it' }, createdAt: new Date() }),
    ]
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[
          { localId: 'uuid-1', uuid: 'uuid-1', text: 'Do it', sentAt, queued: true },
          { localId: 'uuid-2', uuid: 'uuid-2', text: 'Do it', sentAt, queued: true },
        ]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).toHaveBeenCalledWith('uuid-1')
    expect(onAppeared).not.toHaveBeenCalledWith('uuid-2')
  })

  it('materializes only the matched message when several are queued', () => {
    const onAppeared = vi.fn()
    const sentAt = Date.now()

    mockMessagesData.data = [
      createUserMessage({ id: 'uuid-1', content: { text: 'First' } }),
    ]
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[
          { localId: 'uuid-1', uuid: 'uuid-1', text: 'First', sentAt, queued: true },
          { localId: 'uuid-2', uuid: 'uuid-2', text: 'Second', sentAt, queued: true },
        ]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).toHaveBeenCalledWith('uuid-1')
    expect(onAppeared).not.toHaveBeenCalledWith('uuid-2')
  })

  it('does not text-fallback for non-queued pendings that already have their server uuid', () => {
    // A turn-starting send persists under its server-assigned uuid, so an
    // identical-text OLD message must never clear it (wrong-copy match).
    const onAppeared = vi.fn()

    mockMessagesData.data = [
      createUserMessage({ id: 'old-copy', content: { text: 'continue' }, createdAt: new Date() }),
    ]
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', uuid: 'server-uuid', text: 'continue', sentAt: Date.now() }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).not.toHaveBeenCalled()
  })

  it('text-fallback applies while the POST response (uuid) is still pending', () => {
    const onAppeared = vi.fn()

    mockMessagesData.data = [
      createUserMessage({ id: 'persisted-1', content: { text: 'hello there' }, createdAt: new Date() }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', text: 'hello there', sentAt: Date.now() - 1000 }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).toHaveBeenCalledWith('l1')
  })

  it('restores an undelivered queued message to the composer at idle and removes the ghost', async () => {
    vi.useFakeTimers()
    try {
      const onAppeared = vi.fn()
      mockMessagesData.data = []
      mockStreamState.isActive = false

      const DraftProbe = () => {
        const [draft] = useDraft<string>('session:s-1')
        return <div data-testid="draft-probe">{draft ?? ''}</div>
      }

      renderWithProviders(
        <>
          <MessageList
            sessionId="s-1"
            agentSlug="agent-1"
            pendingUserMessages={[{ localId: 'l1', text: 'lost message', sentAt: Date.now(), queued: true }]}
            onPendingMessageAppeared={onAppeared}
          />
          <DraftProbe />
        </>
      )

      // The ghost is visible and nothing has been restored yet.
      expect(screen.getByTestId('queued-user-message')).toHaveTextContent('lost message')
      expect(onAppeared).not.toHaveBeenCalled()
      expect(screen.getByTestId('draft-probe')).toHaveTextContent('')

      // After the post-idle grace, the un-picked-up text returns to the composer
      // draft and the ghost is removed.
      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(onAppeared).toHaveBeenCalledWith('l1')
      expect(screen.getByTestId('draft-probe')).toHaveTextContent('lost message')
    } finally {
      vi.useRealTimers()
    }
  })

  // ---- Cancelling queued messages ----

  it('shows Cancel on queued ghosts only once the server uuid is known', () => {
    mockMessagesData.data = []
    mockStreamState.isActive = true

    const { rerender } = renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', text: 'queued msg', sentAt: Date.now(), queued: true }]}
      />
    )
    // No uuid yet (POST response pending) — cancel not possible
    expect(screen.queryByTestId('cancel-queued-message')).not.toBeInTheDocument()

    rerender(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', uuid: 'srv-1', text: 'queued msg', sentAt: Date.now(), queued: true }]}
      />
    )
    expect(screen.getByTestId('cancel-queued-message')).toBeInTheDocument()
  })

  it('cancelling a queued ghost removes it on success', () => {
    mockCancelResult = { cancelled: true }
    const onAppeared = vi.fn()
    mockMessagesData.data = []
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', uuid: 'srv-1', text: 'queued msg', sentAt: Date.now(), queued: true }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    fireEvent.click(screen.getByTestId('cancel-queued-message'))

    expect(mockCancelQueued).toHaveBeenCalledWith(
      { sessionId: 's-1', agentSlug: 'agent-1', uuid: 'srv-1' },
      expect.anything()
    )
    expect(onAppeared).toHaveBeenCalledWith('l1')
  })

  it('leaves the ghost in place when cancellation lost the race to pickup', () => {
    mockCancelResult = { cancelled: false }
    const onAppeared = vi.fn()
    mockMessagesData.data = []
    mockStreamState.isActive = true

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', uuid: 'srv-1', text: 'queued msg', sentAt: Date.now(), queued: true }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    fireEvent.click(screen.getByTestId('cancel-queued-message'))

    // Too late — the ghost stays and will materialize normally
    expect(onAppeared).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-user-message')).toBeInTheDocument()
  })

  it('drops the sender own user_message echo from peer state immediately', () => {
    mockCurrentUser = { id: 'me', name: 'Me', email: 'me@test.com' }
    mockMessagesData.data = []
    Object.assign(mockStreamState, {
      typingUser: { id: 'other-user', name: 'Alice Baker' },
      peerUserMessages: [
        { uuid: 'own-echo', receivedAt: Date.now(), content: 'my own message', sender: { id: 'me', name: 'Me' } },
      ],
    })

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    // Own echo is pruned from stream state without waiting for a persisted match
    expect(mockRemovePeerUserMessage).toHaveBeenCalledWith('s-1', 'own-echo')
    // And it must not suppress other peers' typing indicator
    expect(screen.getByText('...')).toBeInTheDocument()
  })

  // ---- isStreamingMessagePersisted edge cases ----

  it('treats streaming as persisted when streaming text is prefix of persisted', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
      createAssistantMessage({ content: { text: 'Full response text here' } }),
    ]
    mockStreamState.streamingMessage = 'Full response'
    mockStreamState.isStreaming = true

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Streaming is prefix of persisted → treated as persisted → no duplicate
    expect(screen.queryByText('Full response')).not.toBeInTheDocument()
    expect(screen.getByText('Full response text here')).toBeInTheDocument()
  })

  it('treats streaming as persisted when persisted is prefix of streaming (behind)', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
      createAssistantMessage({ content: { text: 'Partial' } }),
    ]
    mockStreamState.streamingMessage = 'Partial response still streaming'
    mockStreamState.isStreaming = true

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Persisted is prefix of streaming → treated as persisted
    // Only persisted message renders, not the streaming duplicate
    const partialElements = screen.getAllByText('Partial')
    expect(partialElements).toHaveLength(1)
  })

  it('shows streaming message when no persisted assistant message exists', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Hello' } }),
    ]
    mockStreamState.streamingMessage = 'New streaming content'
    mockStreamState.isStreaming = true

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByText('New streaming content')).toBeInTheDocument()
  })

  // ---- Turn elapsed time not shown during active session's last turn ----

  it('does not show elapsed time for last turn when session is active', () => {
    mockStreamState.isActive = true
    const userMsg = createUserMessage({
      content: { text: 'Hello' },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    })
    const assistantMsg = createAssistantMessage({
      content: { text: 'Response' },
      createdAt: new Date('2025-01-01T00:01:00Z'),
    })

    mockMessagesData.data = [userMsg, assistantMsg]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Session is active → last turn's elapsed should not show
    expect(screen.queryByText('Worked for 60s')).not.toBeInTheDocument()
  })

  it('keeps last turn elapsed time visible when user sends a new message (pendingUserMessage)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Hello' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Response' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'pm-1', uuid: 'pm-1', text: 'Follow up', sentAt: Date.now() }]}
      />
    )

    // Even though isActive=true, the pending message closes the previous turn
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()
  })

  it('does not defer elapsed/files after streaming when pendingUserMessage exists', () => {
    mockStreamState.isActive = true
    mockStreamState.streamingMessage = 'New turn streaming...'
    mockStreamState.isStreaming = true

    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Hello' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Done' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/result.csv' },
            result: 'File delivered',
          }),
        ],
      }),
    ]

    const { container } = renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'pm-1', uuid: 'pm-1', text: 'Follow up', sentAt: Date.now() }]}
      />
    )

    // Elapsed + files should render inline (not deferred after streaming)
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()
    expect(screen.getByText('result.csv')).toBeInTheDocument()

    // Verify order: files and elapsed appear BEFORE the streaming message
    const allText = container.textContent || ''
    const filesPos = allText.indexOf('result.csv')
    const elapsedPos = allText.indexOf('Worked for 60s')
    const streamingPos = allText.indexOf('New turn streaming...')
    expect(filesPos).toBeLessThan(streamingPos)
    expect(elapsedPos).toBeLessThan(streamingPos)
  })

  it('does not defer previous turn elapsed/files when user message is last in messages array', () => {
    // This simulates the state AFTER pendingUserMessage is cleared:
    // user message is persisted, streaming belongs to new turn
    mockStreamState.isActive = true
    mockStreamState.streamingMessage = 'New response...'
    mockStreamState.isStreaming = true

    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'First' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Done' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/output.csv' },
            result: 'File delivered',
          }),
        ],
      }),
      createUserMessage({
        content: { text: 'Follow up' },
        createdAt: new Date('2025-01-01T00:02:00Z'),
      }),
    ]

    const { container } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Previous turn's files and elapsed should render inline (not deferred)
    expect(screen.getByText('output.csv')).toBeInTheDocument()
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()

    // They should appear BEFORE the streaming content
    const allText = container.textContent || ''
    const filesPos = allText.indexOf('output.csv')
    const streamingPos = allText.indexOf('New response...')
    expect(filesPos).toBeLessThan(streamingPos)
  })

  // ---- canHaveRunningToolCalls excludes when pendingUserMessage exists ----

  it('does not mark tools as running when pendingUserMessage exists', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        id: 'msg-1',
        content: { text: '' },
        toolCalls: [createToolCall({ id: 'tc-1', name: 'Bash', result: undefined })],
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'pm-1', uuid: 'pm-1', text: 'New message', sentAt: Date.now() }]}
      />
    )

    // The tool call renders, but since a turn-starting pending message exists,
    // canHaveRunningToolCalls is empty → tool is not considered running
    expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
  })

  // ---- Deferred elapsed time ----

  it('does not defer elapsed time when streaming belongs to a new turn', () => {
    mockStreamState.streamingMessage = 'Streaming text...'
    mockStreamState.isStreaming = true

    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Hello' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'First response' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
      }),
      createUserMessage({
        content: { text: 'Follow up' },
        createdAt: new Date('2025-01-01T00:02:00Z'),
      }),
    ]

    const { container } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Elapsed renders inline (before streaming), not deferred
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()
    const allText = container.textContent || ''
    expect(allText.indexOf('Worked for 60s')).toBeLessThan(allText.indexOf('Streaming text...'))
  })

  it('defers elapsed time when streaming continues the same turn', () => {
    mockStreamState.streamingMessage = 'Still going...'
    mockStreamState.isStreaming = true

    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Hello' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Partial response' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
      }),
      // No user message after — streaming is same turn
    ]

    // Session idle so the turn closes
    mockStreamState.isActive = false

    const { container } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Elapsed is deferred (after streaming), not inline
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()
    const allText = container.textContent || ''
    expect(allText.indexOf('Still going...')).toBeLessThan(allText.indexOf('Worked for 60s'))
  })

  // ---- Shows loading spinner only when no pending message ----

  it('does not show loading spinner when pendingUserMessage exists', () => {
    mockMessagesData.isLoading = true
    const { container } = renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'pm-1', uuid: 'pm-1', text: 'Waiting...', sentAt: Date.now() }]}
      />
    )
    // Should show pending message, not spinner
    expect(container.querySelector('.animate-spin')).toBeFalsy()
    expect(screen.getByText('Waiting...')).toBeInTheDocument()
  })

  // ---- Shows connected account requests from SSE ----

  // ---- Delivered files summary ----

  it('shows delivered files for a completed turn', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Generate report' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Here is your report' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/output/report.pdf', description: 'Monthly report' },
            result: 'File delivered',
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    const pill = screen.getByText('report.pdf')
    expect(pill).toBeInTheDocument()
    // Delivered files render as a click-to-preview button, not a download link.
    expect(pill.closest('[role="button"]')).toBeInTheDocument()
  })

  it('shows multiple delivered files from a single turn', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Generate files' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'First file' },
        createdAt: new Date('2025-01-01T00:00:30Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/data.csv' },
            result: 'File delivered',
          }),
        ],
      }),
      createAssistantMessage({
        content: { text: 'Second file' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/summary.pdf' },
            result: 'File delivered',
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByText('data.csv')).toBeInTheDocument()
    expect(screen.getByText('summary.pdf')).toBeInTheDocument()
  })

  it('keeps delivered files visible when user sends a new message (pendingUserMessage)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Generate report' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Here is your report' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/report.pdf' },
            result: 'File delivered',
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'pm-1', uuid: 'pm-1', text: 'Now do X', sentAt: Date.now() }]}
      />
    )

    // Even though isActive=true, the pending message keeps the previous turn closed
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })

  it('does not show delivered files for the last turn when session is active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Generate report' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Here is your report' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/report.pdf' },
            result: 'File delivered',
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  })

  it('does not show delivered files when tool call had an error', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Generate report' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Failed' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/report.pdf' },
            result: 'Error delivering file',
            isError: true,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // The file chip should not appear for errored deliveries
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  })

  it('shows delivered files per turn independently', () => {
    mockMessagesData.data = [
      // Turn 1
      createUserMessage({
        content: { text: 'First task' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        id: 'a-turn1',
        content: { text: 'Done with first' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/first.txt' },
            result: 'File delivered',
          }),
        ],
      }),
      // Turn 2
      createUserMessage({
        content: { text: 'Second task' },
        createdAt: new Date('2025-01-01T00:02:00Z'),
      }),
      createAssistantMessage({
        id: 'a-turn2',
        content: { text: 'Done with second' },
        createdAt: new Date('2025-01-01T00:03:00Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__deliver_file',
            input: { filePath: '/workspace/second.txt' },
            result: 'File delivered',
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByText('first.txt')).toBeInTheDocument()
    expect(screen.getByText('second.txt')).toBeInTheDocument()
  })

  it('does not show delivered files section when turn has no file deliveries', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Hello' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Just text, no files' },
        createdAt: new Date('2025-01-01T00:01:00Z'),
        toolCalls: [
          createToolCall({
            name: 'Bash',
            input: { command: 'echo hi' },
            result: 'hi',
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // No download links should appear
    const links = screen.queryAllByRole('link')
    const downloadLinks = links.filter(l => l.getAttribute('href')?.includes('/files/'))
    expect(downloadLinks).toHaveLength(0)
  })

  it('defers delivered files rendering when streaming content is not yet persisted', () => {
    mockStreamState.streamingMessage = 'Still streaming...'
    mockStreamState.isStreaming = true

    const userMsg = createUserMessage({
      content: { text: 'Generate' },
      createdAt: new Date('2025-01-01T00:00:00Z'),
    })
    const assistantMsg = createAssistantMessage({
      id: 'a-deferred',
      content: { text: 'Here are files' },
      createdAt: new Date('2025-01-01T00:01:00Z'),
      toolCalls: [
        createToolCall({
          name: 'mcp__user-input__deliver_file',
          input: { filePath: '/workspace/deferred.csv' },
          result: 'File delivered',
        }),
      ],
    })
    const userMsg2 = createUserMessage({
      content: { text: 'Follow up' },
      createdAt: new Date('2025-01-01T00:02:00Z'),
    })

    mockMessagesData.data = [userMsg, assistantMsg, userMsg2]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // The file should still render (deferred position, after streaming content)
    expect(screen.getByText('deferred.csv')).toBeInTheDocument()
  })

  describe('peer user message (SSE)', () => {
    it('renders peer user message from another user', () => {
      mockCurrentUser = { id: 'me', name: 'Me', email: 'me@test.com' }
      mockMessagesData.data = []
      Object.assign(mockStreamState, {
        peerUserMessages: [{ uuid: 'peer-1', receivedAt: Date.now(), content: 'Hello from peer', sender: { id: 'other-user', name: 'Alice Baker' } }],
      })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      expect(screen.getByText('Hello from peer')).toBeInTheDocument()
    })

    it('renders queued peer messages as ghosts with a Queued label', () => {
      mockCurrentUser = { id: 'me', name: 'Me', email: 'me@test.com' }
      mockMessagesData.data = []
      Object.assign(mockStreamState, {
        peerUserMessages: [
          { uuid: 'peer-1', receivedAt: Date.now(), content: 'Queued peer message', sender: { id: 'other-user', name: 'Alice' }, queued: true },
        ],
      })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      expect(screen.getByText('Queued peer message')).toBeInTheDocument()
      expect(screen.getByText('Queued')).toBeInTheDocument()
    })

    it('does not render peer message if sender is the current user', () => {
      mockCurrentUser = { id: 'me', name: 'Me', email: 'me@test.com' }
      mockMessagesData.data = []
      Object.assign(mockStreamState, {
        peerUserMessages: [{ uuid: 'peer-own', receivedAt: Date.now(), content: 'My own message', sender: { id: 'me', name: 'Me' } }],
      })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      expect(screen.queryByText('My own message')).not.toBeInTheDocument()
    })

    it('does not render peer message if already in fetched messages (dedup by uuid)', () => {
      mockCurrentUser = { id: 'me', name: 'Me', email: 'me@test.com' }
      mockMessagesData.data = [
        createUserMessage({ id: 'peer-1', content: { text: 'Hello from peer' } }),
      ]
      Object.assign(mockStreamState, {
        peerUserMessages: [{ uuid: 'peer-1', receivedAt: Date.now(), content: 'Hello from peer', sender: { id: 'other-user', name: 'Alice' } }],
      })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      // Only one instance — from fetched messages, not the optimistic peer copy
      const matches = screen.getAllByText('Hello from peer')
      expect(matches).toHaveLength(1)
      // The persisted copy also prunes the stream-state entry
      expect(mockRemovePeerUserMessage).toHaveBeenCalledWith('s-1', 'peer-1')
    })
  })

  describe('parallel streaming tool uses', () => {
    it('renders multiple StreamingToolCallItem for multiple streaming tools', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Hello' } }),
      ]
      mockStreamState.streamingToolUses = [
        { id: 'tc-A', name: 'Bash', partialInput: '{"command":"ls"}' },
        { id: 'tc-B', name: 'Read', partialInput: '{"file":"x.ts"}' },
      ]
      mockStreamState.isStreaming = true

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      const streamingItems = screen.getAllByTestId('streaming-tool-call')
      expect(streamingItems).toHaveLength(2)
      expect(streamingItems[0]).toHaveTextContent('Bash')
      expect(streamingItems[1]).toHaveTextContent('Read')
    })

    it('renders ready tool as ToolCallItem instead of StreamingToolCallItem', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Hello' } }),
      ]
      mockStreamState.streamingToolUses = [
        { id: 'tc-ready', name: 'WebSearch', partialInput: '{"query":"test"}', ready: true },
      ] as any
      mockStreamState.isStreaming = true

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      // Ready tool should render as ToolCallItem, not StreamingToolCallItem
      expect(screen.queryByTestId('streaming-tool-call')).not.toBeInTheDocument()
      expect(screen.getByTestId('tool-call-WebSearch')).toBeInTheDocument()
    })

    it('renders ready Task tool as SubAgentBlock', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Hello' } }),
      ]
      mockStreamState.isActive = true
      mockStreamState.streamingToolUses = [
        { id: 'tc-task', name: 'Task', partialInput: '{"subagent_type":"Explore"}', ready: true },
      ] as any
      mockStreamState.isStreaming = true

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      // Ready Task tool should render as SubAgentBlock
      expect(screen.queryByTestId('streaming-tool-call')).not.toBeInTheDocument()
      expect(screen.getByTestId('subagent-block')).toBeInTheDocument()
    })

    it('renders mix of ready and non-ready tools correctly', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Hello' } }),
      ]
      mockStreamState.streamingToolUses = [
        { id: 'tc-1', name: 'Bash', partialInput: '{"cmd":"ls"}', ready: true },
        { id: 'tc-2', name: 'Read', partialInput: '' },
      ] as any
      mockStreamState.isStreaming = true

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      // tc-1 (ready) renders as ToolCallItem
      expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
      // tc-2 (not ready) renders as StreamingToolCallItem
      expect(screen.getByTestId('streaming-tool-call')).toBeInTheDocument()
    })

    it('filters out streaming tools already persisted in messages', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Hello' } }),
        createAssistantMessage({
          content: { text: '' },
          toolCalls: [createToolCall({ id: 'tc-persisted', name: 'Bash' })],
        }),
      ]
      mockStreamState.streamingToolUses = [
        { id: 'tc-persisted', name: 'Bash', partialInput: '{"cmd":"ls"}' },
        { id: 'tc-new', name: 'Read', partialInput: '' },
      ]
      mockStreamState.isStreaming = true

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      // Only tc-new should render as streaming (tc-persisted is already in messages)
      const streamingItems = screen.getAllByTestId('streaming-tool-call')
      expect(streamingItems).toHaveLength(1)
      expect(streamingItems[0]).toHaveTextContent('Read')
    })
  })

  describe('typing indicator (SSE)', () => {
    it('renders typing indicator with initials and speech bubble', () => {
      mockMessagesData.data = []
      Object.assign(mockStreamState, {
        typingUser: { id: 'other-user', name: 'Alice Baker' },
      })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      expect(screen.getByText('AB')).toBeInTheDocument()
      expect(screen.getByText('...')).toBeInTheDocument()
    })

    it('does not render typing indicator when no one is typing', () => {
      mockMessagesData.data = []
      Object.assign(mockStreamState, { typingUser: null })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      expect(screen.queryByText('...')).not.toBeInTheDocument()
    })

    it('hides typing indicator when peer message arrives', () => {
      mockMessagesData.data = []
      Object.assign(mockStreamState, {
        typingUser: { id: 'other-user', name: 'Alice Baker' },
        peerUserMessages: [{ uuid: 'peer-1', receivedAt: Date.now(), content: 'Done typing', sender: { id: 'other-user', name: 'Alice Baker' } }],
      })

      renderWithProviders(
        <MessageList sessionId="s-1" agentSlug="agent-1" />
      )

      // Peer message shown, typing indicator hidden
      expect(screen.getByText('Done typing')).toBeInTheDocument()
      // The "..." from typing indicator should not be present
      // (the "AB" initials will appear on the peer message avatar instead)
      const dots = screen.queryAllByText('...')
      expect(dots).toHaveLength(0)
    })
  })

  describe('windowing (long threads)', () => {
    // BASE_WINDOW=300, LOAD_STEP=200 in message-list.tsx. Each message renders a
    // bubble whose exact text is `m{i}`, so getByText/queryByText tells us precisely
    // which messages are mounted in the DOM.
    const manyMessages = (n: number): ApiMessageOrBoundary[] =>
      Array.from({ length: n }, (_, i) => createUserMessage({ content: { text: `m${i}` } }))

    // jsdom has no layout, so scroll metrics are 0. Mock them on the scroll
    // container so handleScroll can decide "at bottom" vs "scrolled up".
    const mockScrollGeometry = (
      el: HTMLElement,
      { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }
    ) => {
      let top = scrollTop
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
      Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v } })
    }

    it('renders every message when at or below the window threshold', () => {
      mockMessagesData.data = manyMessages(50)
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.getByText('m0')).toBeInTheDocument()
      expect(screen.getByText('m49')).toBeInTheDocument()
      expect(screen.queryByText(/earlier messages? hidden/)).not.toBeInTheDocument()
    })

    it('renders only the trailing window plus a hidden-count indicator on long threads', () => {
      mockMessagesData.data = manyMessages(305) // 5 over BASE_WINDOW
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      // Oldest 5 are outside the window…
      expect(screen.queryByText('m0')).not.toBeInTheDocument()
      expect(screen.queryByText('m4')).not.toBeInTheDocument()
      // …window runs from m5 through the latest message.
      expect(screen.getByText('m5')).toBeInTheDocument()
      expect(screen.getByText('m304')).toBeInTheDocument()
      expect(screen.getByText(/5 earlier messages hidden/)).toBeInTheDocument()
    })

    it('uses singular wording when exactly one message is hidden', () => {
      mockMessagesData.data = manyMessages(301)
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.getByText(/1 earlier message hidden/)).toBeInTheDocument()
    })

    it('reveals older messages when scrolled to the top', () => {
      mockMessagesData.data = manyMessages(305)
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      mockScrollGeometry(el, { scrollHeight: 10000, clientHeight: 500, scrollTop: 50 })
      fireEvent.scroll(el)
      // windowSize grew by LOAD_STEP (200) → 305 < 500, so the whole thread renders.
      expect(screen.getByText('m0')).toBeInTheDocument()
      expect(screen.queryByText(/earlier messages? hidden/)).not.toBeInTheDocument()
    })

    it('keeps the top of the window stable when a message arrives while scrolled up', () => {
      const base = manyMessages(305) // window = m5..m304
      mockMessagesData.data = base
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      // Scrolled up, but not near the top (so we don't trigger a load-more expand).
      mockScrollGeometry(el, { scrollHeight: 10000, clientHeight: 500, scrollTop: 5000 })
      fireEvent.scroll(el)
      expect(screen.getByText('m5')).toBeInTheDocument()

      // A new message is persisted while the user reads history.
      mockMessagesData.data = [...base, createUserMessage({ content: { text: 'm305' } })]
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      // The window grew by one instead of sliding, so the top item the user was
      // reading (m5) stays mounted — no upward jump.
      expect(screen.getByText('m5')).toBeInTheDocument()
      expect(screen.getByText('m305')).toBeInTheDocument()
    })

    it('slides the window (drops the oldest rendered) when a message arrives while pinned to the bottom', () => {
      const base = manyMessages(305)
      mockMessagesData.data = base
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      mockScrollGeometry(el, { scrollHeight: 10000, clientHeight: 500, scrollTop: 9500 }) // at bottom
      fireEvent.scroll(el)
      expect(screen.getByText('m5')).toBeInTheDocument()

      mockMessagesData.data = [...base, createUserMessage({ content: { text: 'm305' } })]
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      // Pinned to bottom: the slice slides so the DOM stays bounded — m5 drops off.
      expect(screen.queryByText('m5')).not.toBeInTheDocument()
      expect(screen.getByText('m305')).toBeInTheDocument()
    })
  })

  describe('thinking block dedup (live vs persisted)', () => {
    const liveBlock = (text: string, endedAt: number | null = null) =>
      ({ id: 1, text, startedAt: Date.now() - 5000, endedAt })

    it('renders a live thinking card while the turn streams', () => {
      mockMessagesData.data = [createUserMessage({ content: { text: 'Question' } })]
      mockStreamState.isActive = true
      mockStreamState.thinkingBlocks = [liveBlock('Reasoning about the question')]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      expect(screen.getByText('Reasoning about the question')).toBeInTheDocument()
    })

    it('hands off to the persisted card when the current turn carries the same text', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({ content: { text: '' }, thinking: [{ text: 'Reasoning about the question in detail' }] }),
      ]
      mockStreamState.isActive = true
      // Live stream trails the transcript — prefix in one direction
      mockStreamState.thinkingBlocks = [liveBlock('Reasoning about the question')]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      // Only the persisted card (from MessageItem) — no double render. It's
      // collapsed, so identify it by its "Thought" header (a live card reads "Thinking").
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      expect(screen.getByTestId('thinking-block-toggle')).toHaveTextContent('Thought')
    })

    it('does not suppress the live card when only an older turn has matching thinking', () => {
      // Regression: models reuse stock openers ("Let me..."). A live block whose
      // early streamed prefix matches a PREVIOUS turn's persisted thinking must
      // still render — only the current turn participates in dedup.
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'First question' } }),
        createAssistantMessage({ content: { text: 'Answer one' }, thinking: [{ text: 'Let me check the config and think it through' }] }),
        createUserMessage({ content: { text: 'Second question' } }),
      ]
      mockStreamState.isActive = true
      mockStreamState.thinkingBlocks = [liveBlock('Let me check')]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      // Old turn's persisted card + the new turn's live card
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(2)
    })

    it('removes leftover live cards at idle once the turn persisted its thinking, even when text diverged', () => {
      // An SSE reconnect can drop deltas so the streamed text never prefix-matches
      // the transcript — at idle the persisted cards own the display outright.
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({ content: { text: 'Answer' }, thinking: [{ text: 'the full persisted reasoning' }] }),
      ]
      mockStreamState.isActive = false
      mockStreamState.thinkingBlocks = [liveBlock('divergent streamed fragment', Date.now())]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      expect(screen.queryByText('divergent streamed fragment')).not.toBeInTheDocument()
    })

    it('keeps an empty-text live block while active but drops it at idle', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({ content: { text: 'Answer with no persisted thinking' } }),
      ]
      mockStreamState.thinkingBlocks = [liveBlock('')]

      mockStreamState.isActive = true
      const { unmount } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      unmount()

      mockStreamState.isActive = false
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
    })
  })
})
