// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentActivityIndicator } from './agent-activity-indicator'

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null,
  streamingToolUse: null,
  pendingSecretRequests: [],
  pendingConnectedAccountRequests: [],
  pendingQuestionRequests: [],
  pendingFileRequests: [],
  pendingRemoteMcpRequests: [],
  error: null as string | null,
  browserActive: false,
  activeStartTime: null as number | null,
  isCompacting: false,
  contextUsage: null,
  activeSubagent: null,
  slashCommands: [],
}

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
}))

// Mock useMessages
const mockMessages: any[] = []
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: mockMessages }),
}))

// Mock useElapsedTimer
vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  useElapsedTimer: (startTime: unknown) => (startTime ? '10s' : null),
}))

// Mock cn utility
vi.mock('@shared/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

describe('AgentActivityIndicator', () => {
  beforeEach(() => {
    // Reset to defaults
    Object.assign(mockStreamState, {
      isActive: false,
      error: null,
      activeStartTime: null,
    })
    mockMessages.length = 0
  })

  it('returns null when not active and no error', () => {
    const { container } = render(
      <AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('shows error alert when error is present', () => {
    mockStreamState.error = 'API rate limit exceeded'
    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('API rate limit exceeded')).toBeInTheDocument()
    expect(screen.getByText('Send another message to retry.')).toBeInTheDocument()
  })

  it('shows "Working..." status when active with no todo', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Working...')).toBeInTheDocument()
    expect(screen.getByTestId('activity-indicator')).toBeInTheDocument()
  })

  it('shows elapsed timer when active', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now() - 10000
    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('10s')).toBeInTheDocument()
  })

  it('extracts and displays TodoWrite items', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [
        {
          id: 'tc-1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Set up database', status: 'completed', activeForm: 'Setting up database' },
              { content: 'Write API routes', status: 'in_progress', activeForm: 'Writing API routes' },
              { content: 'Add tests', status: 'pending', activeForm: 'Adding tests' },
            ],
          },
          result: 'ok',
        },
      ],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    // Shows the activeForm of the in_progress item instead of "Working..."
    expect(screen.getByText('Writing API routes')).toBeInTheDocument()

    // Shows todo items
    expect(screen.getByText('Set up database')).toBeInTheDocument()
    expect(screen.getByText('Write API routes')).toBeInTheDocument()
    expect(screen.getByText('Add tests')).toBeInTheDocument()

    // Shows status indicators
    expect(screen.getByText('✓')).toBeInTheDocument()
    expect(screen.getByText('→')).toBeInTheDocument()
    expect(screen.getByText('○')).toBeInTheDocument()
  })

  it('does not show todo list when all items are completed', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [
        {
          id: 'tc-1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Task 1', status: 'completed', activeForm: 'Doing task 1' },
              { content: 'Task 2', status: 'completed', activeForm: 'Doing task 2' },
            ],
          },
          result: 'ok',
        },
      ],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    // Should show Working... since no active item
    expect(screen.getByText('Working...')).toBeInTheDocument()
    // Todo list should not render (all completed)
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument()
  })
})
