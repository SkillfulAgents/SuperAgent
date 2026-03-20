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
  pendingSecretRequests: [] as any[],
  pendingConnectedAccountRequests: [] as any[],
  pendingQuestionRequests: [] as any[],
  pendingFileRequests: [] as any[],
  pendingRemoteMcpRequests: [] as any[],
  pendingBrowserInputRequests: [] as any[],
  error: null as string | null,
  browserActive: false,
  activeStartTime: null as number | null,
  isCompacting: false,
  contextUsage: null,
  activeSubagents: [] as any[],
  completedSubagents: null as Set<string> | null,
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
      activeSubagents: [],
      completedSubagents: null,
      pendingSecretRequests: [],
      pendingConnectedAccountRequests: [],
      pendingQuestionRequests: [],
      pendingFileRequests: [],
      pendingRemoteMcpRequests: [],
      pendingBrowserInputRequests: [],
      isCompacting: false,
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

  it('shows "Waiting for input..." when pending secret requests exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingSecretRequests = [{ toolUseId: 't1', secretName: 'API_KEY' }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
    expect(screen.queryByText('Working...')).not.toBeInTheDocument()
  })

  it('shows "Waiting for input..." when pending question requests exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingQuestionRequests = [{
      toolUseId: 't1',
      questions: [{ question: 'Pick one', header: 'DB', options: [], multiSelect: false }],
    }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
  })

  it('shows "Waiting for input..." when pending connected account requests exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingConnectedAccountRequests = [{ toolUseId: 't1', toolkit: 'github' }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
  })

  it('shows "Waiting for input..." when pending file requests exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingFileRequests = [{ toolUseId: 't1', description: 'Upload CSV' }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
  })

  it('shows "Waiting for input..." when pending remote MCP requests exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingRemoteMcpRequests = [{ toolUseId: 't1', url: 'https://example.com' }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
  })

  it('shows "Waiting for input..." when pending browser input requests exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingBrowserInputRequests = [{ toolUseId: 't1', message: 'Login', requirements: [] }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
  })

  it('shows "Working..." when active but no pending requests', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    // All pending arrays are empty (from beforeEach reset)

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Working...')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for input...')).not.toBeInTheDocument()
  })

  it('does not show "Waiting for input..." when not active even if pending requests exist', () => {
    mockStreamState.isActive = false
    mockStreamState.pendingSecretRequests = [{ toolUseId: 't1', secretName: 'KEY' }]

    const { container } = render(
      <AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />
    )
    // Component should return null when not active
    expect(container.innerHTML).toBe('')
  })

  it('shows "Compacting..." when isCompacting is true', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.isCompacting = true

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Compacting...')).toBeInTheDocument()
    expect(screen.queryByText('Working...')).not.toBeInTheDocument()
  })

  it('"Compacting..." takes priority over TodoWrite activeForm', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.isCompacting = true
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [{
        id: 'tc-1',
        name: 'TodoWrite',
        input: {
          todos: [{ content: 'Doing work', status: 'in_progress', activeForm: 'Setting things up' }],
        },
        result: 'ok',
      }],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Compacting...')).toBeInTheDocument()
    expect(screen.queryByText('Setting things up')).not.toBeInTheDocument()
  })

  it('"Waiting for input..." takes priority over "Compacting..."', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.isCompacting = true
    mockStreamState.pendingSecretRequests = [{ toolUseId: 't1', secretName: 'KEY' }]

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
    expect(screen.queryByText('Compacting...')).not.toBeInTheDocument()
  })

  it('"Waiting for input..." takes priority over TodoWrite activeForm', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockStreamState.pendingSecretRequests = [{ toolUseId: 't1', secretName: 'KEY' }]
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [{
        id: 'tc-1',
        name: 'TodoWrite',
        input: {
          todos: [{ content: 'Doing work', status: 'in_progress', activeForm: 'Setting things up' }],
        },
        result: 'ok',
      }],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Waiting for input...')).toBeInTheDocument()
    expect(screen.queryByText('Setting things up')).not.toBeInTheDocument()
  })
})
