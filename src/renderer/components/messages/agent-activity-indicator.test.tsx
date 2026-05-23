// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { AgentActivityIndicator } from './agent-activity-indicator'

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null,
  streamingToolUses: [],
  pendingSecretRequests: [] as any[],
  pendingConnectedAccountRequests: [] as any[],
  pendingQuestionRequests: [] as any[],
  pendingFileRequests: [] as any[],
  pendingRemoteMcpRequests: [] as any[],
  pendingBrowserInputRequests: [] as any[],
  error: null as string | null,
  apiErrorCode: null as string | null,
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
      apiErrorCode: null,
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

  it('shows LLM provider error alert when apiErrorCode indicates a provider error', () => {
    mockStreamState.error = 'API rate limit exceeded'
    mockStreamState.apiErrorCode = 'rate_limit'
    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('LLM Provider Error')).toBeInTheDocument()
    expect(screen.getByText('API rate limit exceeded')).toBeInTheDocument()
    expect(screen.getByText(/external LLM provider API/)).toBeInTheDocument()
  })

  it('shows generic error alert when no apiErrorCode', () => {
    mockStreamState.error = 'The agent process was terminated unexpectedly.'
    mockStreamState.apiErrorCode = null
    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByText('The agent process was terminated unexpectedly.')).toBeInTheDocument()
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

  // --- TaskCreate / TaskUpdate support ---

  it('builds todo list from TaskCreate tool calls', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [
        {
          id: 'tc-1',
          name: 'TaskCreate',
          input: { subject: 'Set up database', activeForm: 'Setting up database' },
          result: 'Task #1 created successfully: Set up database',
        },
        {
          id: 'tc-2',
          name: 'TaskCreate',
          input: { subject: 'Write API routes', activeForm: 'Writing API routes' },
          result: 'Task #2 created successfully: Write API routes',
        },
        {
          id: 'tc-3',
          name: 'TaskCreate',
          input: { subject: 'Add tests', activeForm: 'Adding tests' },
          result: 'Task #3 created successfully: Add tests',
        },
      ],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('Set up database')).toBeInTheDocument()
    expect(screen.getByText('Write API routes')).toBeInTheDocument()
    expect(screen.getByText('Add tests')).toBeInTheDocument()
    expect(screen.getAllByText('○')).toHaveLength(3)
  })

  it('applies TaskUpdate status changes to task list', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push(
      {
        id: 'msg-1',
        type: 'assistant',
        content: { text: '' },
        toolCalls: [
          {
            id: 'tc-1',
            name: 'TaskCreate',
            input: { subject: 'Set up database', activeForm: 'Setting up database' },
            result: 'Task #1 created successfully',
          },
          {
            id: 'tc-2',
            name: 'TaskCreate',
            input: { subject: 'Write API routes', activeForm: 'Writing API routes' },
            result: 'Task #2 created successfully',
          },
        ],
        createdAt: new Date(),
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: { text: '' },
        toolCalls: [
          {
            id: 'tc-3',
            name: 'TaskUpdate',
            input: { taskId: '1', status: 'completed' },
            result: 'Updated task #1 status',
          },
          {
            id: 'tc-4',
            name: 'TaskUpdate',
            input: { taskId: '2', status: 'in_progress' },
            result: 'Updated task #2 status',
          },
        ],
        createdAt: new Date(),
      },
    )

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    // Task 1 completed, task 2 in progress
    expect(screen.getByText('✓')).toBeInTheDocument()
    expect(screen.getByText('→')).toBeInTheDocument()
    // Shows activeForm of in_progress task as status text
    expect(screen.getByText('Writing API routes')).toBeInTheDocument()
  })

  it('hides task list when all TaskCreate tasks are completed', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [
        {
          id: 'tc-1',
          name: 'TaskCreate',
          input: { subject: 'Task A', activeForm: 'Doing A' },
          result: 'Task #1 created successfully',
        },
        {
          id: 'tc-2',
          name: 'TaskUpdate',
          input: { taskId: '1', status: 'completed' },
          result: 'Updated task #1 status',
        },
      ],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('Working...')).toBeInTheDocument()
    expect(screen.queryByText('Task A')).not.toBeInTheDocument()
  })

  it('truncates to 5 visible tasks, prioritizing not-done', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [
        // 7 tasks: 3 completed, 4 pending
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({
          id: `tc-create-${n}`,
          name: 'TaskCreate',
          input: { subject: `Task ${n}` },
          result: `Task #${n} created successfully`,
        })),
        ...[1, 2, 3].map((n) => ({
          id: `tc-update-${n}`,
          name: 'TaskUpdate',
          input: { taskId: String(n), status: 'completed' },
          result: `Updated task #${n} status`,
        })),
      ],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    // All 4 pending tasks should be visible
    expect(screen.getByText('Task 4')).toBeInTheDocument()
    expect(screen.getByText('Task 5')).toBeInTheDocument()
    expect(screen.getByText('Task 6')).toBeInTheDocument()
    expect(screen.getByText('Task 7')).toBeInTheDocument()
    // 1 completed task fills the remaining slot (Task 3 is newest completed)
    expect(screen.getByText('Task 3')).toBeInTheDocument()
    // The other 2 completed tasks are hidden
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Task 2')).not.toBeInTheDocument()
    // Shows the overflow indicator
    expect(screen.getByText(/2 more.*2 done/)).toBeInTheDocument()
  })

  it('shows all tasks when toggle is clicked', async () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push({
      id: 'msg-1',
      type: 'assistant',
      content: { text: '' },
      toolCalls: [
        ...[1, 2, 3, 4, 5, 6].map((n) => ({
          id: `tc-create-${n}`,
          name: 'TaskCreate',
          input: { subject: `Task ${n}` },
          result: `Task #${n} created successfully`,
        })),
      ],
      createdAt: new Date(),
    })

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    // 1 task hidden
    expect(screen.queryByText('Task 6')).not.toBeInTheDocument()
    expect(screen.getByText(/1 more.*1 pending/)).toBeInTheDocument()

    // Click toggle
    act(() => { screen.getByText(/1 more/).click() })

    // All tasks now visible
    expect(screen.getByText('Task 6')).toBeInTheDocument()
    expect(screen.queryByText(/1 more/)).not.toBeInTheDocument()
    // "Show fewer" button appears
    expect(screen.getByText('Show fewer')).toBeInTheDocument()
  })

  it('prefers TaskCreate/TaskUpdate over TodoWrite when both exist', () => {
    mockStreamState.isActive = true
    mockStreamState.activeStartTime = Date.now()
    mockMessages.push(
      {
        id: 'msg-1',
        type: 'assistant',
        content: { text: '' },
        toolCalls: [{
          id: 'tc-1',
          name: 'TodoWrite',
          input: {
            todos: [{ content: 'Old todo item', status: 'in_progress', activeForm: 'Old active form' }],
          },
          result: 'ok',
        }],
        createdAt: new Date(),
      },
      {
        id: 'msg-2',
        type: 'assistant',
        content: { text: '' },
        toolCalls: [{
          id: 'tc-2',
          name: 'TaskCreate',
          input: { subject: 'New task item', activeForm: 'New active form' },
          result: 'Task #1 created successfully',
        }],
        createdAt: new Date(),
      },
    )

    render(<AgentActivityIndicator sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('New task item')).toBeInTheDocument()
    expect(screen.queryByText('Old todo item')).not.toBeInTheDocument()
  })
})
