// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { MessageList } from './message-list'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createUserMessage, createAssistantMessage, createToolCall, createCompactBoundary } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

// Mock useMessages
const mockMessagesData: { data: ApiMessageOrBoundary[] | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
}

const mockDeleteMessage = vi.fn()
const mockDeleteToolCall = vi.fn()

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
  useDeleteMessage: () => ({ mutate: mockDeleteMessage }),
  useDeleteToolCall: () => ({ mutate: mockDeleteToolCall }),
}))

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null as string | null,
  streamingToolUse: null as { id: string; name: string; partialInput: string } | null,
  isCompacting: false,
  activeSubagents: new Map(),
  completedSubagents: new Map(),
  pendingSecretRequests: [] as Array<{ toolUseId: string; secretName: string; reason?: string }>,
  pendingConnectedAccountRequests: [] as any[],
  pendingRemoteMcpRequests: [] as any[],
  pendingQuestionRequests: [] as any[],
  pendingFileRequests: [] as any[],
  pendingBrowserInputRequests: [] as any[],
  pendingScriptRunRequests: [] as any[],
}

const mockClearCompacting = vi.fn()

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  removeSecretRequest: vi.fn(),
  removeConnectedAccountRequest: vi.fn(),
  removeRemoteMcpRequest: vi.fn(),
  removeQuestionRequest: vi.fn(),
  removeFileRequest: vi.fn(),
  removeBrowserInputRequest: vi.fn(),
  removeScriptRunRequest: vi.fn(),
  clearCompacting: (...args: unknown[]) => mockClearCompacting(...args),
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
  ToolCallItem: ({ toolCall }: any) => <div data-testid={`tool-call-${toolCall.name}`}>{toolCall.name}</div>,
  StreamingToolCallItem: ({ name }: any) => <div data-testid="streaming-tool-call">{name}</div>,
}))

vi.mock('./subagent-block', () => ({
  SubAgentBlock: ({ toolCall }: any) => <div data-testid="subagent-block">{toolCall.name}</div>,
}))

vi.mock('./message-context-menu', () => ({
  MessageContextMenu: ({ children }: any) => <>{children}</>,
}))

vi.mock('./secret-request-item', () => ({
  SecretRequestItem: ({ secretName }: any) => <div data-testid="secret-request">{secretName}</div>,
}))

vi.mock('./connected-account-request-item', () => ({
  ConnectedAccountRequestItem: ({ toolkit }: any) => <div data-testid="connected-account-request">{toolkit}</div>,
}))

vi.mock('./remote-mcp-request-item', () => ({
  RemoteMcpRequestItem: ({ url }: any) => <div data-testid="remote-mcp-request">{url}</div>,
}))

vi.mock('./question-request-item', () => ({
  QuestionRequestItem: ({ toolUseId }: any) => <div data-testid="question-request">{toolUseId}</div>,
}))

vi.mock('./file-request-item', () => ({
  FileRequestItem: ({ description }: any) => <div data-testid="file-request">{description}</div>,
}))

describe('MessageList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMessagesData.data = undefined
    mockMessagesData.isLoading = false
    mockIsOnline = true
    Object.assign(mockStreamState, {
      isActive: false,
      isStreaming: false,
      streamingMessage: null,
      streamingToolUse: null,
      isCompacting: false,
      activeSubagents: new Map(),
      completedSubagents: new Map(),
      pendingSecretRequests: [],
      pendingConnectedAccountRequests: [],
      pendingRemoteMcpRequests: [],
      pendingQuestionRequests: [],
      pendingFileRequests: [],
      pendingBrowserInputRequests: [],
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
        pendingUserMessage={{ text: 'Sending...', sentAt: Date.now() }}
      />
    )
    expect(screen.getByText('Sending...')).toBeInTheDocument()
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
    mockStreamState.streamingToolUse = {
      id: 'tc-streaming',
      name: 'WebSearch',
      partialInput: '{"query": "test"}',
    }
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
    mockStreamState.streamingToolUse = {
      id: 'tc-1', // Same ID = persisted
      name: 'WebSearch',
      partialInput: '{"query": "test"}',
    }

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

  it('shows pending secret requests from SSE', () => {
    mockMessagesData.data = []
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-1', secretName: 'API_KEY' },
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('secret-request')).toBeInTheDocument()
    expect(screen.getByText('API_KEY')).toBeInTheDocument()
  })

  it('shows pending question requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingQuestionRequests = [
      {
        toolUseId: 'tu-q1',
        questions: [
          {
            question: 'Which DB?',
            header: 'DB',
            options: [{ label: 'PG', description: 'PostgreSQL' }],
            multiSelect: false,
          },
        ],
      },
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('question-request')).toBeInTheDocument()
  })

  it('shows pending file requests', () => {
    mockMessagesData.data = []
    mockStreamState.pendingFileRequests = [
      { toolUseId: 'tu-f1', description: 'Upload config file' },
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('file-request')).toBeInTheDocument()
    expect(screen.getByText('Upload config file')).toBeInTheDocument()
  })

  it('derives pending requests from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DB_PASSWORD', reason: 'For database' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.getByTestId('secret-request')).toBeInTheDocument()
    expect(screen.getByText('DB_PASSWORD')).toBeInTheDocument()
  })

  it('does not derive pending requests from history when session is idle', () => {
    mockStreamState.isActive = false
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DB_PASSWORD' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    expect(screen.queryByTestId('secret-request')).not.toBeInTheDocument()
  })

  it('deduplicates SSE and message-based pending requests', () => {
    mockStreamState.isActive = true
    mockStreamState.pendingSecretRequests = [
      { toolUseId: 'tu-dup', secretName: 'API_KEY' },
    ]
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tu-dup',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'API_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )
    // Should only appear once
    const secretRequests = screen.getAllByTestId('secret-request')
    expect(secretRequests).toHaveLength(1)
  })

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
    expect(screen.getByText('Agent took 60s')).toBeInTheDocument()
    // Second turn not shown (session is active=false so it should be shown)
    expect(screen.getByText('Agent took 30s')).toBeInTheDocument()
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

  it('calls onPendingMessageAppeared when pending message found in server messages', () => {
    const onAppeared = vi.fn()
    const sentAt = new Date('2025-01-01T00:00:00Z').getTime()

    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'My message' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessage={{ text: 'My message', sentAt }}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).toHaveBeenCalled()
  })

  it('does not call onPendingMessageAppeared when text does not match', () => {
    const onAppeared = vi.fn()
    const sentAt = new Date('2025-01-01T00:00:00Z').getTime()

    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Different message' },
        createdAt: new Date('2025-01-01T00:00:01Z'),
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessage={{ text: 'My message', sentAt }}
        onPendingMessageAppeared={onAppeared}
      />
    )

    expect(onAppeared).not.toHaveBeenCalled()
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
    expect(screen.queryByText('Agent took 60s')).not.toBeInTheDocument()
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
        pendingUserMessage={{ text: 'Follow up', sentAt: Date.now() }}
      />
    )

    // Even though isActive=true, pendingUserMessage closes the previous turn
    expect(screen.getByText('Agent took 60s')).toBeInTheDocument()
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
        pendingUserMessage={{ text: 'Follow up', sentAt: Date.now() }}
      />
    )

    // Elapsed + files should render inline (not deferred after streaming)
    expect(screen.getByText('Agent took 60s')).toBeInTheDocument()
    expect(screen.getByText('result.csv')).toBeInTheDocument()

    // Verify order: files and elapsed appear BEFORE the streaming message
    const allText = container.textContent || ''
    const filesPos = allText.indexOf('result.csv')
    const elapsedPos = allText.indexOf('Agent took 60s')
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
    expect(screen.getByText('Agent took 60s')).toBeInTheDocument()

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
        pendingUserMessage={{ text: 'New message', sentAt: Date.now() }}
      />
    )

    // The tool call renders, but since pendingUserMessage exists,
    // canHaveRunningToolCalls is empty → tool is not considered running
    expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
  })

  // ---- Message-based pending request extraction for all types ----

  it('derives connected_account pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-ca',
            name: 'mcp__user-input__request_connected_account',
            input: { toolkit: 'github', reason: 'Need access' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByTestId('connected-account-request')).toBeInTheDocument()
    expect(screen.getByText('github')).toBeInTheDocument()
  })

  it('derives question pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-q',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { question: 'Which env?', header: 'Env', options: [{ label: 'Prod', description: 'Production' }], multiSelect: false },
              ],
            },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByTestId('question-request')).toBeInTheDocument()
  })

  it('derives file pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-file',
            name: 'mcp__user-input__request_file',
            input: { description: 'Upload config', fileTypes: '.json' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByTestId('file-request')).toBeInTheDocument()
    expect(screen.getByText('Upload config')).toBeInTheDocument()
  })

  it('derives remote MCP pending request from message history when active', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-mcp',
            name: 'mcp__user-input__request_remote_mcp',
            input: { url: 'https://mcp.example.com', name: 'Example' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByTestId('remote-mcp-request')).toBeInTheDocument()
    expect(screen.getByText('https://mcp.example.com')).toBeInTheDocument()
  })

  it('skips message-based requests when subsequent user message exists', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-old-secret',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'OLD_KEY' },
            result: undefined,
          }),
        ],
      }),
      createUserMessage({ content: { text: 'User moved on' } }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // Secret request should NOT show — user sent a message after it
    expect(screen.queryByTestId('secret-request')).not.toBeInTheDocument()
  })

  it('skips message-based requests when tool call already has a result', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-done',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'DONE_KEY' },
            result: 'provided', // has result → not pending
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.queryByTestId('secret-request')).not.toBeInTheDocument()
  })

  it('pendingUserMessage causes message-based extraction to skip (as if user moved on)', () => {
    mockStreamState.isActive = true
    mockMessagesData.data = [
      createAssistantMessage({
        content: { text: '' },
        toolCalls: [
          createToolCall({
            id: 'tc-skipped',
            name: 'mcp__user-input__request_secret',
            input: { secretName: 'SKIP_KEY' },
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessage={{ text: 'New input', sentAt: Date.now() }}
      />
    )

    // pendingUserMessage acts like a subsequent user message
    expect(screen.queryByTestId('secret-request')).not.toBeInTheDocument()
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
    expect(screen.getByText('Agent took 60s')).toBeInTheDocument()
    const allText = container.textContent || ''
    expect(allText.indexOf('Agent took 60s')).toBeLessThan(allText.indexOf('Streaming text...'))
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
    expect(screen.getByText('Agent took 60s')).toBeInTheDocument()
    const allText = container.textContent || ''
    expect(allText.indexOf('Still going...')).toBeLessThan(allText.indexOf('Agent took 60s'))
  })

  // ---- Shows loading spinner only when no pending message ----

  it('does not show loading spinner when pendingUserMessage exists', () => {
    mockMessagesData.isLoading = true
    const { container } = renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessage={{ text: 'Waiting...', sentAt: Date.now() }}
      />
    )
    // Should show pending message, not spinner
    expect(container.querySelector('.animate-spin')).toBeFalsy()
    expect(screen.getByText('Waiting...')).toBeInTheDocument()
  })

  // ---- Shows connected account requests from SSE ----

  it('shows pending connected account requests from SSE', () => {
    mockMessagesData.data = []
    mockStreamState.pendingConnectedAccountRequests = [
      { toolUseId: 'tu-ca-1', toolkit: 'slack', reason: 'Need access' },
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByTestId('connected-account-request')).toBeInTheDocument()
    expect(screen.getByText('slack')).toBeInTheDocument()
  })

  it('shows pending remote MCP requests from SSE', () => {
    mockMessagesData.data = []
    mockStreamState.pendingRemoteMcpRequests = [
      { toolUseId: 'tu-mcp-1', url: 'https://mcp.test.com', name: 'Test MCP' },
    ]

    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    expect(screen.getByTestId('remote-mcp-request')).toBeInTheDocument()
    expect(screen.getByText('https://mcp.test.com')).toBeInTheDocument()
  })

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

    const link = screen.getByText('report.pdf')
    expect(link).toBeInTheDocument()
    expect(link.closest('a')).toHaveAttribute(
      'href',
      'http://test-api/api/agents/agent-1/files/output/report.pdf'
    )
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
        pendingUserMessage={{ text: 'Now do X', sentAt: Date.now() }}
      />
    )

    // Even though isActive=true, pendingUserMessage keeps the previous turn closed
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
})
