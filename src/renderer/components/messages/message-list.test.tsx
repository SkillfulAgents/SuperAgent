// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, act, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MessageList } from './message-list'
import { useDraft } from '@renderer/context/drafts-context'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createUserMessage, createAssistantMessage, createToolCall, createCompactBoundary } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

// Mock useMessages
const mockFetchOlder = vi.fn()
const mockMessagesData: {
  data: ApiMessageOrBoundary[] | undefined
  isLoading: boolean
  error: Error | null
  fetchOlder: typeof mockFetchOlder
  hasOlder: boolean
  isFetchingOlder: boolean
} = {
  data: undefined,
  isLoading: false,
  error: null,
  fetchOlder: mockFetchOlder,
  hasOlder: false,
  isFetchingOlder: false,
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
  discardedCommandUuids: [] as string[],
  thinkingBlocks: [] as Array<{ id: number; persistedId?: string; text: string; startedAt: number; endedAt: number | null }>,
}

const mockClearCompacting = vi.fn()
const mockRemovePeerUserMessage = vi.fn()
const mockClearPeerUserMessages = vi.fn()
const mockConsumeDiscardedCommand = vi.fn()

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  clearCompacting: (...args: unknown[]) => mockClearCompacting(...args),
  removePeerUserMessage: (...args: unknown[]) => mockRemovePeerUserMessage(...args),
  clearPeerUserMessages: (...args: unknown[]) => mockClearPeerUserMessages(...args),
  consumeDiscardedCommand: (...args: unknown[]) => mockConsumeDiscardedCommand(...args),
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

vi.mock('./informational-item', () => ({
  InformationalItem: ({ item }: any) => (
    <div data-testid="informational-item">{item.content}</div>
  ),
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
    mockFetchOlder.mockReset()
    mockMessagesData.data = undefined
    mockMessagesData.isLoading = false
    mockMessagesData.error = null
    mockMessagesData.hasOlder = false
    mockMessagesData.isFetchingOlder = false
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
      discardedCommandUuids: [],
      thinkingBlocks: [],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  describe('session time flags', () => {
    it('renders a flag immediately before the first actual user message', () => {
      mockMessagesData.data = [
        createUserMessage({
          content: { text: '[SYSTEM] Hidden setup message' },
          createdAt: new Date(2026, 7, 17, 8, 59, 0),
        }),
        createUserMessage({
          content: { text: 'First actual prompt' },
          createdAt: new Date(2026, 7, 17, 9, 0, 0),
        }),
        createAssistantMessage({
          content: { text: 'First response' },
          createdAt: new Date(2026, 7, 17, 9, 1, 0),
        }),
      ]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      expect(screen.queryByText('[SYSTEM] Hidden setup message')).not.toBeInTheDocument()
      const flag = screen.getByTestId('session-time-flag')
      const firstUserMessage = screen.getByText('First actual prompt')
      expect(
        flag.compareDocumentPosition(firstUserMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0)
    })

    it('renders another flag when the user replies more than 15 minutes after the latest assistant response', () => {
      mockMessagesData.data = [
        createUserMessage({
          content: { text: 'Initial prompt' },
          createdAt: new Date(2026, 7, 17, 9, 0, 0),
        }),
        createAssistantMessage({
          content: { text: 'Interim response' },
          createdAt: new Date(2026, 7, 17, 9, 1, 0),
        }),
        createAssistantMessage({
          content: { text: 'Latest response' },
          createdAt: new Date(2026, 7, 17, 9, 10, 0),
        }),
        {
          id: 'notice-between-response-and-reply',
          type: 'informational',
          content: 'Background notice',
          createdAt: new Date(2026, 7, 17, 9, 11, 0),
        },
        createUserMessage({
          content: { text: 'Delayed follow-up' },
          createdAt: new Date(2026, 7, 17, 9, 25, 1),
        }),
      ]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      const flags = screen.getAllByTestId('session-time-flag')
      expect(flags).toHaveLength(2)
      expect(
        flags[1].compareDocumentPosition(screen.getByText('Delayed follow-up')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0)
    })

    it('does not render another flag at exactly 15 minutes from the latest assistant response', () => {
      mockMessagesData.data = [
        createUserMessage({
          content: { text: 'Initial prompt' },
          createdAt: new Date(2026, 7, 17, 9, 0, 0),
        }),
        createAssistantMessage({
          content: { text: 'Older response' },
          createdAt: new Date(2026, 7, 17, 9, 1, 0),
        }),
        createAssistantMessage({
          content: { text: 'Latest response' },
          createdAt: new Date(2026, 7, 17, 9, 15, 0),
        }),
        createUserMessage({
          content: { text: 'Exactly-on-the-boundary follow-up' },
          createdAt: new Date(2026, 7, 17, 9, 30, 0),
        }),
      ]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      expect(screen.getAllByTestId('session-time-flag')).toHaveLength(1)
    })

    it('does not treat the first loaded user message as the session start when older messages exist', () => {
      mockMessagesData.data = [
        createUserMessage({
          content: { text: 'First message in the loaded page' },
          createdAt: new Date(2026, 7, 17, 9, 0, 0),
        }),
        createAssistantMessage({
          content: { text: 'Loaded response' },
          createdAt: new Date(2026, 7, 17, 9, 1, 0),
        }),
      ]
      mockMessagesData.hasOlder = true

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      expect(screen.queryByTestId('session-time-flag')).not.toBeInTheDocument()
    })

    it('shows the first-user flag immediately for an optimistic message', () => {
      mockMessagesData.data = []

      renderWithProviders(
        <MessageList
          sessionId="s-1"
          agentSlug="agent-1"
          pendingUserMessages={[{
            localId: 'pending-first-user',
            text: 'Optimistic first prompt',
            sentAt: new Date(2026, 7, 17, 9, 0, 0).getTime(),
          }]}
        />
      )

      const flag = screen.getByTestId('session-time-flag')
      const pendingMessage = screen.getByText('Optimistic first prompt')
      expect(
        flag.compareDocumentPosition(pendingMessage) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0)
    })
  })

  it('reserves clearance for an overlaid session footer', () => {
    mockMessagesData.data = []
    renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" bottomInset={180} />
    )

    // A real element rather than padding: the follow library measures the
    // content box, so footer growth must be part of it.
    expect(screen.getByTestId('live-edge-clearance')).toHaveStyle({ height: '196px' })
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
    // Streamed prose is split into per-word reveal spans, so match on textContent.
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('Streaming response...')
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

  it('does not show a disclosure row for completed turns with only text', () => {
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

    expect(screen.queryByTestId('turn-summary')).not.toBeInTheDocument()
    expect(screen.getByText('Response')).toBeInTheDocument()
    expect(screen.getByText('Second response')).toBeInTheDocument()
  })

  it('collapses completed turn work and keeps the final text visible', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Build it' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'I am inspecting the project.' },
        createdAt: new Date('2025-01-01T00:00:10Z'),
        toolCalls: [createToolCall({ name: 'Bash' })],
        usage: {
          inputTokens: 60,
          outputTokens: 20,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 0,
        },
      }),
      createAssistantMessage({
        content: { text: 'Implemented the change.' },
        createdAt: new Date('2025-01-01T00:00:30Z'),
        toolCalls: [createToolCall({ name: 'Read' })],
        usage: {
          inputTokens: 200,
          outputTokens: 30,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('Implemented the change.')).toBeInTheDocument()
    expect(screen.queryByText('I am inspecting the project.')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Bash')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Read')).not.toBeInTheDocument()
    expect(screen.getByText('Worked for 30s')).toBeInTheDocument()
    expect(screen.getByText('2 tool calls')).toBeInTheDocument()
    // Uses the same raw-field sum as the session usage popup. In the first
    // response inputTokens already covers the cache subset, but billed usage
    // still reports both fields: 60 + 20 + 50 + 200 + 30 = 360.
    expect(screen.getByText('360 tokens')).toBeInTheDocument()

    const summary = screen.getByTestId('turn-summary')
    expect(summary).toHaveAccessibleName('Expand completed turn work')
    fireEvent.click(summary)

    expect(screen.getByText('I am inspecting the project.')).toBeInTheDocument()
    expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
    expect(screen.getByTestId('tool-call-Read')).toBeInTheDocument()
    expect(screen.getByTestId('turn-summary')).toHaveAttribute('aria-expanded', 'true')
    expect(summary).toHaveAccessibleName('Collapse completed turn work')
    expect(screen.getByTestId('turn-work-detail')).toHaveClass(
      'animate-in',
      'fade-in-0',
      'slide-in-from-top-2',
    )
    expect(screen.getByTestId('tool-call-Read').closest('.animate-in')).toHaveClass(
      'fade-in-0',
      'slide-in-from-top-2',
    )
  })

  it('splits completed work around queued steering messages', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Start the slow work' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'Working through the task.' },
        createdAt: new Date('2025-01-01T00:00:05Z'),
        toolCalls: [createToolCall({ name: 'Bash' })],
      }),
      createAssistantMessage({
        content: { text: 'Finished the slow work.' },
        createdAt: new Date('2025-01-01T00:00:10Z'),
      }),
      createUserMessage({
        content: { text: 'late instruction' },
        queued: true,
        createdAt: new Date('2025-01-01T00:00:11Z'),
      }),
      createAssistantMessage({
        content: { text: 'Adapting the work.' },
        createdAt: new Date('2025-01-01T00:00:15Z'),
        toolCalls: [createToolCall({ name: 'Read' })],
      }),
      createAssistantMessage({
        content: { text: 'Adjusting based on: late instruction' },
        createdAt: new Date('2025-01-01T00:00:20Z'),
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('Finished the slow work.')).toBeInTheDocument()
    expect(screen.getByText('Adjusting based on: late instruction')).toBeInTheDocument()
    expect(screen.queryByText('Working through the task.')).not.toBeInTheDocument()
    expect(screen.queryByText('Adapting the work.')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Bash')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Read')).not.toBeInTheDocument()

    const summaries = screen.getAllByTestId('turn-summary')
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toHaveTextContent('Worked for 10s')
    expect(summaries[1]).toHaveTextContent('Worked for 9s')

    const transcript = screen.getByTestId('message-list').textContent ?? ''
    expect(transcript.indexOf('Start the slow work')).toBeLessThan(
      transcript.indexOf('Worked for 10s'),
    )
    expect(transcript.indexOf('Worked for 10s')).toBeLessThan(
      transcript.indexOf('late instruction'),
    )
    expect(transcript.indexOf('late instruction')).toBeLessThan(
      transcript.indexOf('Worked for 9s'),
    )
    expect(transcript.indexOf('Worked for 9s')).toBeLessThan(
      transcript.indexOf('Adjusting based on: late instruction'),
    )
  })

  it('keeps structural notices visible inside a collapsed turn', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Do the work' } }),
      createAssistantMessage({
        content: { text: 'Hidden intermediate work.' },
        toolCalls: [createToolCall({ name: 'Bash' })],
      }),
      {
        id: 'notice-1',
        type: 'informational',
        content: 'A mid-turn agent notice.',
        createdAt: new Date('2025-01-01T00:00:02Z'),
      },
      createAssistantMessage({ content: { text: 'Final answer.' } }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('A mid-turn agent notice.')).toBeInTheDocument()
    expect(screen.getByText('Final answer.')).toBeInTheDocument()
    expect(screen.queryByText('Hidden intermediate work.')).not.toBeInTheDocument()
  })

  it('keeps a cancelled terminal tool call visible without an empty disclosure row', () => {
    mockMessagesData.data = [
      createUserMessage({
        content: { text: 'Sign me in' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      }),
      createAssistantMessage({
        content: { text: 'This step needs you.' },
        createdAt: new Date('2025-01-01T00:00:30Z'),
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__request_browser_input',
            result: undefined,
          }),
        ],
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('This step needs you.')).toBeInTheDocument()
    expect(
      screen.getByTestId('tool-call-mcp__user-input__request_browser_input'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('turn-summary')).not.toBeInTheDocument()
  })

  it('keeps only terminal user-input calls visible when parallel calls complete out of order', () => {
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Finish the workflow' } }),
      createAssistantMessage({
        content: { text: 'Doing the hidden setup.' },
        toolCalls: [createToolCall({ name: 'Bash' })],
      }),
      createAssistantMessage({
        content: { text: 'This step needs you.' },
        toolCalls: [
          createToolCall({
            name: 'mcp__user-input__request_browser_input',
            result: undefined,
          }),
          createToolCall({ name: 'Read' }),
        ],
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('This step needs you.')).toBeInTheDocument()
    expect(
      screen.getByTestId('tool-call-mcp__user-input__request_browser_input'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Read')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Bash')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('turn-summary'))
    expect(screen.getByTestId('tool-call-Read')).toBeInTheDocument()
    expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
    expect(screen.getByTestId('tool-call-Read').closest('.animate-in')).toHaveClass(
      'fade-in-0',
      'slide-in-from-top-2',
    )
    expect(
      screen
        .getByTestId('tool-call-mcp__user-input__request_browser_input')
        .closest('.animate-in'),
    ).toBeNull()
  })

  it('leaves the current streaming turn fully expanded', () => {
    mockStreamState.isActive = true
    mockStreamState.isStreaming = true
    mockStreamState.streamingMessage = 'Writing the final response...'
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Build it' } }),
      createAssistantMessage({
        content: { text: 'Inspecting first.' },
        toolCalls: [createToolCall({ name: 'Bash' })],
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('Inspecting first.')).toBeInTheDocument()
    expect(screen.getByTestId('tool-call-Bash')).toBeInTheDocument()
    // The live streaming message is the last assistant item; its prose is split
    // into per-word reveal spans, so match on textContent.
    const assistantMessages = screen.getAllByTestId('message-assistant')
    expect(assistantMessages[assistantMessages.length - 1]).toHaveTextContent(
      'Writing the final response...'
    )
    expect(screen.queryByTestId('turn-summary')).not.toBeInTheDocument()
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

  it('does not restore /compact over a draft typed while manual compaction runs', async () => {
    vi.useFakeTimers()
    try {
      mockMessagesData.data = []
      mockStreamState.isActive = true
      mockStreamState.isCompacting = true

      const CompactRaceHarness = () => {
        const [pending, setPending] = useState([
          { localId: 'compact-local', uuid: 'compact-server', text: '/compact', sentAt: Date.now() },
        ])
        const [draft, setDraft] = useDraft<string>('session:s-1')

        return (
          <>
            <button onClick={() => setDraft('the next message')}>Type next message</button>
            <MessageList
              sessionId="s-1"
              agentSlug="agent-1"
              pendingUserMessages={pending}
              onPendingMessageAppeared={(localId) => {
                setPending((current) => current.filter((message) => message.localId !== localId))
              }}
            />
            <div data-testid="draft-probe">{draft ?? ''}</div>
          </>
        )
      }

      const { rerender } = renderWithProviders(<CompactRaceHarness />)

      // The user starts composing the next turn while /compact is active.
      fireEvent.click(screen.getByRole('button', { name: 'Type next message' }))
      expect(screen.getByTestId('draft-probe')).toHaveTextContent('the next message')

      // The completion event can reach the renderer before the refetched compact
      // boundary. The accepted command has no persisted user-message counterpart,
      // so the generic idle rescue must not mistake it for lost user text while
      // the boundary is still absent.
      mockStreamState.isActive = false
      mockStreamState.isCompacting = false
      rerender(<CompactRaceHarness />)

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(screen.getByTestId('draft-probe')).toHaveTextContent('the next message')
      expect(screen.getByTestId('draft-probe')).not.toHaveTextContent('/compact')
      expect(screen.queryByText('/compact')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
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
      createAssistantMessage({
        content: { text: 'Continuing' },
        createdAt: new Date('2025-01-01T00:00:20Z'),
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
  })

  it('attributes elapsed time to the steered work phase once idle', () => {
    mockStreamState.isActive = false
    mockMessagesData.data = [
      createUserMessage({ content: { text: 'Start' }, createdAt: new Date('2025-01-01T00:00:00Z') }),
      createAssistantMessage({ content: { text: 'Searching' }, createdAt: new Date('2025-01-01T00:00:09Z') }),
      createUserMessage({ content: { text: 'Steer' }, createdAt: new Date('2025-01-01T00:00:10Z'), queued: true }),
      createAssistantMessage({
        content: { text: 'Continuing' },
        createdAt: new Date('2025-01-01T00:00:20Z'),
        thinking: [{ text: 'Hidden reasoning' }],
      }),
    ]

    renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

    // The queued message starts a visual work phase without becoming a new
    // agent turn. Its elapsed time starts at the steering message.
    expect(screen.getByText('Worked for 10s')).toBeInTheDocument()
    expect(screen.queryByText('Worked for 20s')).not.toBeInTheDocument()
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

  it('rescues a queued ghost immediately when the runtime reports its command discarded', async () => {
    // Deterministic path: a command_lifecycle discarded/cancelled frame named
    // this uuid (e.g. killed by Stop). No idle, no grace timer — the session
    // is even still ACTIVE — the rescue must fire right away.
    const onAppeared = vi.fn()
    mockMessagesData.data = []
    mockStreamState.isActive = true
    mockStreamState.discardedCommandUuids = ['u-dead']

    const DraftProbe = () => {
      const [draft] = useDraft<string>('session:s-1')
      return <div data-testid="draft-probe">{draft ?? ''}</div>
    }

    renderWithProviders(
      <>
        <MessageList
          sessionId="s-1"
          agentSlug="agent-1"
          pendingUserMessages={[{ localId: 'l1', uuid: 'u-dead', text: 'killed by stop', sentAt: Date.now(), queued: true }]}
          onPendingMessageAppeared={onAppeared}
        />
        <DraftProbe />
      </>
    )

    await act(async () => {})

    expect(onAppeared).toHaveBeenCalledWith('l1')
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('killed by stop')
    expect(mockConsumeDiscardedCommand).toHaveBeenCalledWith('s-1', 'u-dead')
  })

  it('leaves a queued ghost alone when the discarded uuid belongs to a different command', async () => {
    const onAppeared = vi.fn()
    mockMessagesData.data = []
    mockStreamState.isActive = true
    mockStreamState.discardedCommandUuids = ['someone-else']

    renderWithProviders(
      <MessageList
        sessionId="s-1"
        agentSlug="agent-1"
        pendingUserMessages={[{ localId: 'l1', uuid: 'u-alive', text: 'still queued', sentAt: Date.now(), queued: true }]}
        onPendingMessageAppeared={onAppeared}
      />
    )

    await act(async () => {})

    expect(onAppeared).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-user-message')).toHaveTextContent('still queued')
    expect(mockConsumeDiscardedCommand).not.toHaveBeenCalled()
  })

  it('does not restore a non-queued pending whose POST is still in flight', async () => {
    // A send into a waking container: the session still reads inactive and the
    // POST has not returned a uuid yet. The message is usually mid-delivery —
    // yanking it back into the composer makes it land in the transcript AND
    // the input (the restored-successful-send bug). Failure of the POST has
    // its own restore path (the composer's catch), so idle-restore must leave
    // these pending.
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
            pendingUserMessages={[{ localId: 'l1', text: 'mid-delivery message', sentAt: Date.now() }]}
            onPendingMessageAppeared={onAppeared}
          />
          <DraftProbe />
        </>
      )

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(onAppeared).not.toHaveBeenCalled()
      expect(screen.getByTestId('draft-probe')).toHaveTextContent('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still restores a non-queued pending that was accepted (uuid) but never materialized', async () => {
    // The POST succeeded but the message never showed up in the transcript by
    // idle (e.g. an interrupt raced the CLI before it persisted the entry) —
    // this is genuinely lost work, so the restore must still fire.
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
            pendingUserMessages={[{ localId: 'l1', uuid: 'server-uuid', text: 'accepted then dropped', sentAt: Date.now() }]}
            onPendingMessageAppeared={onAppeared}
          />
          <DraftProbe />
        </>
      )

      await act(async () => {
        vi.advanceTimersByTime(1500)
      })

      expect(onAppeared).toHaveBeenCalledWith('l1')
      expect(screen.getByTestId('draft-probe')).toHaveTextContent('accepted then dropped')
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

    // Streamed prose is split into per-word reveal spans, so match on textContent.
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('New streaming content')
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
        thinking: [{ text: 'Hidden reasoning' }],
        toolCalls: [
          createToolCall({ name: 'Bash' }),
          createToolCall({ name: 'Read' }),
        ],
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
        thinking: [{ text: 'Hidden reasoning' }],
        toolCalls: [
          createToolCall({ name: 'Read' }),
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
        thinking: [{ text: 'Hidden reasoning' }],
        toolCalls: [
          createToolCall({ name: 'Read' }),
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
        thinking: [{ text: 'Hidden reasoning' }],
        toolCalls: [
          createToolCall({ name: 'Bash' }),
          createToolCall({ name: 'Read' }),
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
        toolCalls: [createToolCall({ name: 'Read' })],
      }),
      // No user message after — streaming is same turn
    ]

    // Session idle so the turn closes
    mockStreamState.isActive = false

    const { container } = renderWithProviders(
      <MessageList sessionId="s-1" agentSlug="agent-1" />
    )

    // A divergent live buffer may be stale. Keep the latest persisted response
    // visible, while its ordinary tool work stays in the disclosure.
    expect(screen.getByText('Worked for 60s')).toBeInTheDocument()
    const allText = container.textContent || ''
    expect(allText.indexOf('Worked for 60s')).toBeLessThan(
      allText.indexOf('Partial response'),
    )
    expect(allText.indexOf('Partial response')).toBeLessThan(allText.indexOf('Still going...'))
    expect(screen.getByText('Partial response')).toBeInTheDocument()
    expect(screen.queryByTestId('tool-call-Read')).not.toBeInTheDocument()
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
    // BASE_WINDOW=300, LOAD_STEP=200 in use-message-list-scroll.ts. Each message renders a
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

    it('fetches the next API page when scrolled to the top of a fully-rendered page', () => {
      mockMessagesData.data = manyMessages(50)
      mockMessagesData.hasOlder = true
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      mockScrollGeometry(el, { scrollHeight: 10000, clientHeight: 500, scrollTop: 50 })
      fireEvent.scroll(el)
      expect(mockFetchOlder).toHaveBeenCalledOnce()
    })

    it('retries fetchOlder after a failed older page instead of wedging scroll-up', () => {
      mockFetchOlder.mockResolvedValue(false)
      mockMessagesData.data = manyMessages(50)
      mockMessagesData.hasOlder = true
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      mockScrollGeometry(el, { scrollHeight: 10000, clientHeight: 500, scrollTop: 50 })
      fireEvent.scroll(el)
      expect(mockFetchOlder).toHaveBeenCalledOnce()
      fireEvent.scroll(el)
      expect(mockFetchOlder).toHaveBeenCalledTimes(2)
    })

    // Geometry derives from the mounted row count, so the restore effect only
    // sees scrollHeight growth at the commit where the prepended rows mount.
    // Fixed-geometry mocks cannot catch a guard consumed one commit too early.
    it('compensates scrollTop when an older page prepends above the viewport', () => {
      const base = Array.from({ length: 300 }, (_, i) =>
        createUserMessage({ content: { text: `row${i}` } })
      )
      mockMessagesData.data = base
      mockMessagesData.hasOlder = true
      let onBeforePrepend: (() => void) | undefined
      mockFetchOlder.mockImplementation((cb?: () => void) => {
        onBeforePrepend = cb
        return Promise.resolve(true)
      })

      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      let top = 50
      Object.defineProperty(el, 'scrollHeight', {
        configurable: true,
        get: () => (el.textContent?.match(/(?:row|old)\d+/g)?.length ?? 0) * 10,
      })
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 })
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (v: number) => { top = v },
      })

      fireEvent.scroll(el)
      expect(mockFetchOlder).toHaveBeenCalledOnce()
      expect(onBeforePrepend).toBeDefined()

      const older = Array.from({ length: 200 }, (_, i) =>
        createUserMessage({ content: { text: `old${i}` } })
      )
      act(() => {
        // Mirrors the real fetchOlder: capture happens right before the prepend.
        onBeforePrepend!()
        mockMessagesData.data = [...older, ...base]
        rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      })

      // 200 rows (2000px at 10px/row) mounted above the viewport; the content
      // the user was reading stays put: 50 + (5000 - 3000) = 2050.
      expect(screen.getByText('old0')).toBeInTheDocument()
      expect(el.scrollTop).toBe(2050)
    })

    it('keeps the top of the window stable when a message arrives while scrolled up', async () => {
      const base = manyMessages(305) // window = m5..m304
      mockMessagesData.data = base
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      // An escape is input-driven: the upward wheel releases following.
      // Target lands mid-thread, not near the top, so no load-more expand
      // triggers.
      mockScrollGeometry(el, { scrollHeight: 10000, clientHeight: 500, scrollTop: 9500 })
      fireEvent.scroll(el)
      fireEvent.wheel(el, { deltaY: -40 })
      el.scrollTop = 5000
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
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

  describe('new-turn scroll anchoring', () => {
    const pending = { localId: 'pending-turn', text: 'What changed?', sentAt: Date.now() }

    // Live-edge following is convergence-driven: the scroll hook's
    // ResizeObserver on the content wrapper re-pins after every resize.
    // jsdom has no ResizeObserver, so tests that assert the follow handoff
    // install this controllable fake and fire content resizes explicitly.
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = []
      observed: Element[] = []
      constructor(public cb: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this)
      }
      observe(el: Element) {
        this.observed.push(el)
      }
      unobserve() {}
      disconnect() {}
    }
    let realResizeObserver: typeof ResizeObserver | undefined
    const installFakeResizeObserver = () => {
      realResizeObserver = globalThis.ResizeObserver
      FakeResizeObserver.instances = []
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    }
    afterEach(() => {
      if (realResizeObserver) {
        globalThis.ResizeObserver = realResizeObserver
        realResizeObserver = undefined
      }
    })
    // Fires only the observers watching `contentEl` (the follow engine's),
    // not the reserve-sync observers on other elements.
    const fireContentResize = (contentEl: Element, height: number) => {
      for (const observer of FakeResizeObserver.instances) {
        if (observer.observed.includes(contentEl)) {
          observer.cb(
            [{ contentRect: { height } } as ResizeObserverEntry],
            observer as unknown as ResizeObserver,
          )
        }
      }
    }

    function mockTurnGeometry(el: HTMLElement, { reducedMotion = true } = {}) {
      let naturalScrollHeight = 1300
      let scrollTop = 700
      let clientHeight = 600
      let anchorDocumentTop = 1200
      const spacerHeight = () => Number.parseFloat(
        (el.querySelector('[data-testid="turn-anchor-spacer"]') as HTMLElement | null)?.style.height || '0',
      ) || 0

      vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList)

      Object.defineProperty(el, 'scrollHeight', {
        configurable: true,
        get: () => naturalScrollHeight + spacerHeight(),
      })
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        // Browsers clamp scrollTop when removing the turn spacer lowers the
        // scrollable maximum. Model that here so retiring the reserve has the
        // same observable effect as it does in the real transcript.
        get: () => Math.min(
          scrollTop,
          Math.max(0, naturalScrollHeight + spacerHeight() - clientHeight),
        ),
        set: (value: number) => { scrollTop = value },
      })

      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const top = this === el
          ? 0
          : (this as HTMLElement).dataset.turnAnchorId
            ? anchorDocumentTop - scrollTop
            : 0
        return {
          x: 0,
          y: top,
          top,
          bottom: top,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }
      })

      return {
        get scrollTop() { return el.scrollTop },
        setScrollTop(value: number) { scrollTop = value },
        setNaturalScrollHeight(value: number) { naturalScrollHeight = value },
        setClientHeight(value: number) { clientHeight = value },
        setAnchorDocumentTop(value: number) { anchorDocumentTop = value },
      }
    }

    it('places a newly sent message 100px from the top and reserves room below it', () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList
          sessionId="s-1"
          agentSlug="agent-1"
          pendingUserMessages={[pending]}
        />,
      )

      const anchor = screen.getByText('What changed?').closest('[data-turn-anchor-id]') as HTMLElement
      // The engine keeps a 1px allowance at the live edge (its target is
      // scrollHeight - 1 - clientHeight), so the reading line settles at
      // TURN_ANCHOR_TOP + 1.
      expect(anchor.getBoundingClientRect().top).toBe(101)
      expect(geometry.scrollTop).toBe(1099)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })
    })

    it('holds the reading line when content mounts above the anchored turn', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })

      // The previous turn finalizes: its summary header mounts ABOVE the
      // anchor, sliding the reading line 120px down the document.
      geometry.setAnchorDocumentTop(1320)
      geometry.setNaturalScrollHeight(1420)
      await act(async () => {
        fireContentResize(contentWrapper, 1420)
      })

      // The pin carried the viewport to the moved reading line; the reserve
      // did not shrink and nothing dragged the anchor back down the screen.
      await waitFor(() => expect(geometry.scrollTop).toBe(1219))
      const anchor = screen.getByText('What changed?').closest('[data-turn-anchor-id]') as HTMLElement
      expect(anchor.getBoundingClientRect().top).toBe(101)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('leaves an escaped reader alone when content mounts above the anchored turn', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)

      // The reader escapes upward while the reserve still holds.
      fireEvent.scroll(el)
      fireEvent.wheel(el, { deltaY: -40 })
      geometry.setScrollTop(300)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()

      // Above-anchor growth must not move their viewport.
      geometry.setAnchorDocumentTop(1320)
      geometry.setNaturalScrollHeight(1420)
      await act(async () => {
        fireContentResize(contentWrapper, 1420)
      })
      expect(geometry.scrollTop).toBe(300)
    })

    it('re-engages following and returns to the reading line when a send follows an escape', async () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      // Escape: an upward wheel reaching the scroller releases following at
      // the input itself; the scroll events land where it took the reader.
      fireEvent.scroll(el)
      fireEvent.wheel(el, { deltaY: -40 })
      geometry.setScrollTop(300)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()

      // Sending a message overrides the escape: the reader is brought to the
      // new turn's reading line and following re-engages.
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('does not read the send-time collapse clamp as an escape', async () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )

      // The finished turn collapsing above the ghost (same commit as the
      // send) shrinks content, and the browser clamps scrollTop — a
      // browser-originated upward scroll event with no user gesture behind
      // it. It must not latch an escape and surface the pill over the blank
      // reading-line reserve.
      geometry.setScrollTop(900)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('does not read the idle-time turn collapse clamp as an escape', async () => {
      installFakeResizeObserver()
      // An active turn with collapsible work, reader at the live edge.
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Long question' } }),
        createAssistantMessage({
          content: { text: 'Final answer' },
          toolCalls: [createToolCall({ name: 'Bash' })],
        }),
      ]
      mockStreamState.isActive = true
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      fireEvent.scroll(el) // baseline at the live edge
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      // The turn completes: the work collapses into a summary row — a large
      // one-commit shrink whose browser clamp fires an upward scroll event
      // with no user gesture behind it.
      mockStreamState.isActive = false
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.getByTestId('turn-summary')).toBeInTheDocument()
      geometry.setNaturalScrollHeight(900)
      geometry.setScrollTop(300)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })

      // The final answer then renders below the summary and grows the
      // content. Following must still be engaged: the reader is carried to
      // the full response, with no stranded escape affordance.
      geometry.setNaturalScrollHeight(1600)
      await act(async () => {
        fireContentResize(contentWrapper, 1600)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(999))
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('restores the reading line when a transient shrink clamps the held reserve', async () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })
      fireEvent.scroll(el) // baseline at the reading line
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      // A working indicator swapping forms (streamed block replaced by its
      // shorter persisted copy) shrinks natural content while the reserve
      // holds. The browser clamps scrollTop against the momentarily smaller
      // scroll range and leaves it there — the spacer re-inflating afterwards
      // restores the range but not the position. Model the sticky clamp.
      geometry.setNaturalScrollHeight(1240)
      geometry.setScrollTop(1040)
      fireEvent.scroll(el)
      mockStreamState.streamingMessage = 'A different working indicator'
      mockStreamState.isStreaming = true
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )

      // The reserve re-inflates AND the viewport returns to the reading line
      // in the same pass — the held turn must not visibly sag.
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '460px' })
      expect(geometry.scrollTop).toBe(1099)
      // The clamp's scroll echo must not have latched an escape either.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(geometry.scrollTop).toBe(1099)
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('honors a keyboard escape whose scroll classification the collapse shield swallowed', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Long question' } }),
        createAssistantMessage({
          content: { text: 'Final answer' },
          toolCalls: [createToolCall({ name: 'Bash' })],
        }),
      ]
      mockStreamState.isActive = true
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      fireEvent.scroll(el) // baseline at the live edge
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      // The turn completes and collapses — the browser clamp's echo carries
      // a size change and is rightly discarded…
      mockStreamState.isActive = false
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      geometry.setNaturalScrollHeight(900)
      geometry.setScrollTop(300)
      fireEvent.scroll(el)

      // …but right after, the reader pages up. The key input itself must
      // disengage following — no scroll-event inference involved.
      fireEvent.keyDown(el, { key: 'PageUp' })
      geometry.setScrollTop(100)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()

      // Following stays disengaged: later growth must not pull the reader
      // back down to the live edge.
      geometry.setNaturalScrollHeight(1600)
      await act(async () => {
        fireContentResize(contentWrapper, 1600)
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(geometry.scrollTop).toBe(100)
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()
    })

    it('does not let a stale held pointer attribute a clamp: reserve intact, reading line restored', async () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)
      fireEvent.scroll(el) // baseline at the reading line

      // A press whose release never arrived (a native context menu swallowed
      // the pointerup, or focus moved away) — long stale by the time the
      // transcript next changes. It must not read as a live gesture.
      fireEvent.pointerDown(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450))
      })

      // A transient shrink clamps the held reserve (a streamed block swapped
      // for its shorter persisted copy). Nobody is gesturing: the clamp must
      // not eat the reserve, and the reading line must be restored in the
      // same pass.
      geometry.setNaturalScrollHeight(1240)
      geometry.setScrollTop(1040)
      fireEvent.scroll(el)
      mockStreamState.streamingMessage = 'A different working indicator'
      mockStreamState.isStreaming = true
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )

      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '460px' })
      expect(geometry.scrollTop).toBe(1099)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('stops attributing scrolls to a drag once the window loses focus', async () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)
      fireEvent.scroll(el) // baseline at the reading line

      // A real drag begins (press + movement)… then focus leaves the window
      // and the pointerup never arrives.
      fireEvent.pointerDown(el, { clientX: 10, clientY: 10 })
      fireEvent(window, new MouseEvent('pointermove', { clientX: 10, clientY: 40 }))
      fireEvent(window, new Event('blur'))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450))
      })

      // The later clamp is nobody's gesture: no eating, reading line restored.
      geometry.setNaturalScrollHeight(1240)
      geometry.setScrollTop(1040)
      fireEvent.scroll(el)
      mockStreamState.streamingMessage = 'A different working indicator'
      mockStreamState.isStreaming = true
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )

      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '460px' })
      expect(geometry.scrollTop).toBe(1099)
    })

    it('does not honor an upward clamp echo as an escape when input only pointed down', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Long question' } }),
        createAssistantMessage({
          content: { text: 'Final answer' },
          toolCalls: [createToolCall({ name: 'Bash' })],
        }),
      ]
      mockStreamState.isActive = true
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      fireEvent.scroll(el) // baseline at the live edge
      // Give the engine's ResizeObserver a baseline observation before the
      // collapse.
      await act(async () => {
        fireContentResize(contentWrapper, 1300)
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      // Idle trackpad noise: a DOWNWARD wheel tick while riding the bottom.
      fireEvent.wheel(el, { deltaY: 40 })

      // The turn completes and collapses — the browser clamp fires an upward
      // scroll event near the tick. Its size change marks it as layout-caused;
      // it must not read as the user leaving the live edge.
      mockStreamState.isActive = false
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      geometry.setNaturalScrollHeight(900)
      geometry.setScrollTop(300)
      fireEvent.scroll(el)

      // The next block mounts below: the reader now sits well behind the
      // live edge (net shrink so far).
      geometry.setNaturalScrollHeight(1000)
      await act(async () => {
        fireContentResize(contentWrapper, 1000)
      })

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      // A down-tick cannot justify leaving the live edge: following must
      // survive the collapse and keep chasing growth.
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
      geometry.setNaturalScrollHeight(1100)
      await act(async () => {
        fireContentResize(contentWrapper, 1100)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(499))
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('chases streaming growth through the animated glide when motion is allowed', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el, { reducedMotion: false })
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      fireEvent.scroll(el) // baseline at the live edge

      // With motion allowed, a growth-sized gap rides the glide instead of
      // being written in one jump — and still lands exactly on the live edge.
      geometry.setNaturalScrollHeight(1400)
      await act(async () => {
        fireContentResize(contentWrapper, 1400)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(799), { timeout: 3000 })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()

      // A throw-sized gap (collapse clamp, rollback) closes in the same
      // commit — the glide never gets to make a backward jump visible.
      geometry.setNaturalScrollHeight(1800)
      await act(async () => {
        fireContentResize(contentWrapper, 1800)
      })
      expect(geometry.scrollTop).toBe(1199)
    })

    it('converges back instead of escaping when an upward scroll has no input behind it', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      fireEvent.scroll(el) // baseline at the live edge (699 joins the trail)

      // Content grows and convergence writes the new live edge.
      geometry.setNaturalScrollHeight(1500)
      await act(async () => {
        fireContentResize(contentWrapper, 1500)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(899))

      // WebKit's async scrolling can roll that write back to the last
      // composited position: an upward, size-stable scroll event with zero
      // input anywhere near it, landing on a position the scroller recently
      // held. That shape is the engine's, not the reader's — following must
      // not disengage, and convergence must put the viewport back on the
      // live edge.
      geometry.setScrollTop(699)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
      expect(geometry.scrollTop).toBe(899)
    })

    it('releases follow when an input-less scroll lands off the recently-held trail', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      fireEvent.scroll(el) // baseline at the live edge

      // A programmatic jump (app code, an extension, a test driving
      // scrollTo) carries no input evidence either — but it lands where the
      // scroller has NOT recently been. That is an escape, not a rollback:
      // follow must release, and nothing may yank the reader back down.
      geometry.setScrollTop(150)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()
      expect(geometry.scrollTop).toBe(150)
    })

    it('ignores a bounce-back settling inside the live-edge band after a downward wheel', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      fireEvent.scroll(el) // baseline at the live edge

      // A downward wheel at the bottom can overshoot into elastic overscroll;
      // the bounce-back is an upward, size-stable scroll with only downward
      // input behind it. Inside the live-edge band it must not read as an
      // escape and disengage following.
      fireEvent.wheel(el, { deltaY: 40 })
      geometry.setScrollTop(690)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()

      // Following stayed engaged: the next content growth re-pins the live edge.
      geometry.setNaturalScrollHeight(1400)
      await act(async () => {
        fireContentResize(contentWrapper, 1400)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(799))
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('never yanks a long-escaped reader who scrolls downward without reaching the bottom', async () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      fireEvent.scroll(el) // baseline at the live edge
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      // The reader escaped a while ago…
      fireEvent.wheel(el, { deltaY: -60 })
      geometry.setScrollTop(200)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()

      // …and now wheels DOWN a little, still far above the live edge. That
      // gesture-driven scroll must not be "reversed" into a trip to the
      // bottom — they never re-engaged following.
      fireEvent.wheel(el, { deltaY: 40 })
      geometry.setScrollTop(260)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      expect(geometry.scrollTop).toBe(260)
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()
    })

    it('does not let the reserve restore preempt the send glide before its first frame', () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      // Real motion: the send travels via the animated glide, whose first
      // write lands in its first animation frame.
      const geometry = mockTurnGeometry(el, { reducedMotion: false })

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })
      expect(geometry.scrollTop).toBe(700) // pre-glide position; the glide travels from here

      // The POST response assigns the uuid before the glide's first frame.
      // The reserve restore must not fire in that gap and snap the viewport
      // to the reading line.
      rerender(
        <MessageList
          sessionId="s-1"
          agentSlug="agent-1"
          pendingUserMessages={[{ ...pending, uuid: 'server-uuid-1' }]}
        />,
      )
      expect(geometry.scrollTop).toBe(700)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })
    })

    it('spends the reserved room before following streamed content at the live edge', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })

      // While the reserve holds, growth is absorbed by the spacer: the reader
      // does not move (net-zero resize from the engine's perspective).
      geometry.setNaturalScrollHeight(1550)
      mockStreamState.streamingMessage = 'The response is growing'
      mockStreamState.isStreaming = true
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(1099)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '150px' })

      // The reserve is exhausted: the anchor retires…
      geometry.setNaturalScrollHeight(1800)
      mockStreamState.streamingMessage = 'The response has reached the live edge and keeps growing'
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '0px' })

      // …and real content growth hands off to live-edge following, driven by
      // the engine's ResizeObserver on the content wrapper.
      await act(async () => {
        fireContentResize(contentWrapper, 1800)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(1199))
    })

    it('discards reserved room before the reader can leave the live edge', () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })

      // The hold sits at 1099 (the engine's 1px live-edge allowance), so an
      // upward move to 1020 consumes 79px of the reserve.
      fireEvent.wheel(el, { deltaY: -80 })
      geometry.setScrollTop(1020)
      fireEvent.scroll(el)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '321px' })
      expect(geometry.scrollTop).toBe(1020)

      geometry.setScrollTop(699)
      fireEvent.scroll(el)
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '0px' })

      fireEvent.wheel(el, { deltaY: -200 })
      geometry.setScrollTop(500)
      fireEvent.scroll(el)
      const releasedScrollTop = geometry.scrollTop
      geometry.setNaturalScrollHeight(1900)
      mockStreamState.streamingMessage = 'More output after the user took control'
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(releasedScrollTop)
    })

    it('retires a stale turn anchor when the reader manually reaches the true bottom', () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })

      // A nested subagent card can grow before its ResizeObserver callback (or
      // the next stream-state render) synchronizes the turn reserve. That makes
      // a new, lower true bottom reachable while the old anchor is still live.
      geometry.setNaturalScrollHeight(1400)
      fireEvent.wheel(el, { deltaY: 200 })
      geometry.setScrollTop(1200)
      fireEvent.scroll(el)

      // Reaching that true bottom is an explicit request to follow the live
      // edge. The obsolete reading-line reserve must be retired immediately.
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '0px' })
      expect(geometry.scrollTop).toBe(800)

      // The next subagent update must stay bottom-pinned instead of restoring
      // the old anchored scrollTop (the visible snap-up from the recording).
      mockStreamState.activeSubagents = [{
        agentId: 'sub-1',
        parentToolId: 'tool-1',
        subagentType: 'Explore',
        description: 'Explore workspace structure',
      }]
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(800)
    })

    it('retires a stale turn anchor when a scrollbar drag reaches the true bottom', () => {
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)

      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '400px' })

      geometry.setNaturalScrollHeight(1400)
      // Dragging the scrollbar thumb produces pointerdown + scroll only — no
      // wheel, touch, or key events — yet it is just as much an explicit trip
      // to the live edge and must retire the reserve the same way.
      fireEvent.pointerDown(el)
      geometry.setScrollTop(1200)
      fireEvent.scroll(el)

      expect(screen.getByTestId('turn-anchor-spacer')).toHaveStyle({ height: '0px' })
      expect(geometry.scrollTop).toBe(800)

      mockStreamState.activeSubagents = [{
        agentId: 'sub-1',
        parentToolId: 'tool-1',
        subagentType: 'Explore',
        description: 'Explore workspace structure',
      }]
      rerender(
        <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={[pending]} />,
      )
      expect(geometry.scrollTop).toBe(800)
    })

    it('pauses following when the reader escapes upward and resumes on return to the live edge', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      const { rerender } = renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      const contentWrapper = screen.getByTestId('turn-anchor-spacer').parentElement!
      // Escape/attach classification is synchronous now; the flush only
      // drains timers (the brief upward-gesture pin hold).
      const flushClassification = () =>
        act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40))
        })

      // At the live edge, content growth is followed.
      fireEvent.scroll(el)
      await flushClassification()
      geometry.setNaturalScrollHeight(1400)
      mockStreamState.streamingMessage = 'First streamed update'
      mockStreamState.isStreaming = true
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      await act(async () => {
        fireContentResize(contentWrapper, 1400)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(799))

      // An upward wheel escapes: subsequent growth no longer moves the reader.
      fireEvent.wheel(el, { deltaY: -40 })
      geometry.setScrollTop(600)
      fireEvent.scroll(el)
      await flushClassification()
      geometry.setNaturalScrollHeight(1500)
      mockStreamState.streamingMessage = 'Second streamed update'
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      await act(async () => {
        fireContentResize(contentWrapper, 1500)
      })
      expect(geometry.scrollTop).toBe(600)
      expect(screen.getByText('Scroll to bottom')).toBeInTheDocument()

      // Scrolling back down near the live edge re-engages following. (The
      // resize-difference window from the growth above must close first.)
      await flushClassification()
      geometry.setScrollTop(830)
      fireEvent.scroll(el)
      await flushClassification()
      geometry.setNaturalScrollHeight(1600)
      mockStreamState.streamingMessage = 'Third streamed update'
      rerender(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      await act(async () => {
        fireContentResize(contentWrapper, 1600)
      })
      await waitFor(() => expect(geometry.scrollTop).toBe(999))
      expect(screen.queryByText('Scroll to bottom')).not.toBeInTheDocument()
    })

    it('keeps the live edge pinned when the viewport shrinks, but not while escaped', async () => {
      installFakeResizeObserver()
      mockMessagesData.data = [createAssistantMessage({ content: { text: 'Previous response' } })]
      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      const el = screen.getByTestId('message-list')
      const geometry = mockTurnGeometry(el)
      // The engine observes the viewport (`el`) as well as the content
      // wrapper; a viewport resize re-pins the live edge.
      const fireViewportResize = () => fireContentResize(el, 0)

      // At the live edge, a vertical shrink keeps the newest content at the
      // bottom (content leaves from the top, not the bottom): the pin writes
      // scrollTop to the new target, 1300 - 1 - 450.
      geometry.setClientHeight(450)
      fireViewportResize()
      expect(geometry.scrollTop).toBe(849)

      // A beat between resize and gesture, mirroring a real pause.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })

      // Escaped readers keep their place instead: browsers anchor the top
      // edge on resize, and the pin must not yank them to the bottom.
      fireEvent.scroll(el)
      fireEvent.wheel(el, { deltaY: -40 })
      geometry.setScrollTop(500)
      fireEvent.scroll(el)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      geometry.setClientHeight(300)
      fireViewportResize()
      expect(geometry.scrollTop).toBe(500)
    })
  })

  describe('thinking block dedup (live vs persisted)', () => {
    const liveBlock = (text: string, endedAt: number | null = null, persistedId?: string) =>
      ({ id: 1, persistedId, text, startedAt: Date.now() - 5000, endedAt })

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

    it('hands off by stable id while active even when streamed text diverges from the transcript', () => {
      // Regression: a long-running turn can miss SSE reasoning deltas while a
      // background agent keeps isActive=true. Text-prefix matching then leaves
      // the completed live card stranded at the transcript tail indefinitely.
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({
          content: { text: 'Persisted checkpoint' },
          thinking: [{ id: 'msg-1:0', text: 'the full persisted reasoning' }],
        }),
      ]
      mockStreamState.isActive = true
      mockStreamState.thinkingBlocks = [
        liveBlock('a suffix received after reconnect', Date.now(), 'msg-1:0'),
      ]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      expect(screen.queryByText('a suffix received after reconnect')).not.toBeInTheDocument()
      expect(screen.getByTestId('thinking-block-toggle')).toHaveTextContent('Thought')
    })

    it('hands off an empty live block by stable id while the session remains active', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({
          content: { text: 'Persisted checkpoint' },
          thinking: [{ id: 'msg-1:0', text: 'reasoning persisted despite omitted live deltas' }],
        }),
      ]
      mockStreamState.isActive = true
      mockStreamState.thinkingBlocks = [liveBlock('', Date.now(), 'msg-1:0')]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
    })

    it('does not suppress a different id merely because its text matches', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({
          content: { text: '' },
          thinking: [{ id: 'msg-old:0', text: 'reused stock reasoning' }],
        }),
      ]
      mockStreamState.isActive = true
      mockStreamState.thinkingBlocks = [
        liveBlock('reused stock reasoning', null, 'msg-new:0'),
      ]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)

      expect(screen.getAllByTestId('thinking-block')).toHaveLength(2)
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
      // The old completed turn is collapsed, while the new turn's live card
      // remains visible and must not be falsely de-duplicated.
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      fireEvent.click(screen.getByTestId('turn-summary'))
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
      expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('turn-summary'))
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(1)
      expect(screen.queryByText('divergent streamed fragment')).not.toBeInTheDocument()
    })

    it('drops leftover live cards after an interrupt instead of clumping them below the marker', () => {
      // Interrupting a turn appends a "[Request interrupted by user]" USER
      // message to the transcript. The dedup scan must not treat it as the
      // start of a new turn — otherwise it collects no persisted thinking and
      // every live block from the interrupted turn re-renders at the end.
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({ content: { text: '' }, thinking: [{ text: 'first reasoning pass' }] }),
        createAssistantMessage({ content: { text: '' }, thinking: [{ text: 'second reasoning pass' }] }),
        createUserMessage({ content: { text: '[Request interrupted by user]' } }),
      ]
      mockStreamState.isActive = false
      mockStreamState.thinkingBlocks = [
        { id: 1, text: 'first reasoning pass', startedAt: Date.now() - 9000, endedAt: Date.now() - 7000 },
        { id: 2, text: 'second reasoning pass', startedAt: Date.now() - 6000, endedAt: Date.now() - 4000 },
      ]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      // Completed work is collapsed by default. Expansion reveals only the two
      // persisted cards — the live copies must not double-render.
      expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('turn-summary'))
      expect(screen.getAllByTestId('thinking-block')).toHaveLength(2)
    })

    it('drops a live card at idle after an interrupt even when its thinking never persisted', () => {
      // Interrupted mid-first-block: the SDK discards the partial thinking, so
      // there is no persisted counterpart and the live card would strand below
      // the interrupt marker forever.
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createUserMessage({ content: { text: '[Request interrupted by user for tool use]' } }),
      ]
      mockStreamState.isActive = false
      mockStreamState.thinkingBlocks = [liveBlock('partial discarded reasoning', Date.now())]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
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

    it('drops a completed empty-text block while the wider turn remains active', () => {
      mockMessagesData.data = [
        createUserMessage({ content: { text: 'Question' } }),
        createAssistantMessage({ content: { text: 'Starting a tool next' } }),
      ]
      mockStreamState.isActive = true
      mockStreamState.thinkingBlocks = [liveBlock('', Date.now())]

      renderWithProviders(<MessageList sessionId="s-1" agentSlug="agent-1" />)
      expect(screen.queryByTestId('thinking-block')).not.toBeInTheDocument()
    })
  })
})
