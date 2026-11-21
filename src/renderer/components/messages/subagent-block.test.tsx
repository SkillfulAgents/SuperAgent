// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SubAgentBlock, SubagentTranscript } from './subagent-block'
import { createToolCall, createAssistantMessage } from '@renderer/test/factories'
import type { ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

// Mock useSubagentMessages
let mockSubMessages: any[] = []
vi.mock('@renderer/hooks/use-messages', () => ({
  useSubagentMessages: () => ({ data: mockSubMessages }),
}))

// Mock ToolCallItem
vi.mock('./tool-call-item', () => ({
  ToolCallItem: ({ toolCall, isSessionActive }: { toolCall: ApiToolCall; isSessionActive?: boolean }) => (
    <div data-testid={`sub-tool-${toolCall.name}`} data-session-active={String(!!isSessionActive)}>
      {toolCall.name}
    </div>
  ),
  StreamingToolCallItem: ({ name }: { name: string }) => (
    <div data-testid="sub-streaming-tool">{name}</div>
  ),
  StatusIndicator: ({ status }: { status: string }) => (
    <span data-testid="status-indicator">{status}</span>
  ),
}))

// The row opens its transcript as a drawer tab; the drawer itself is not under test here.
const mockOpenSubagent = vi.fn()
let mockSubagents: { open: boolean; viewing: { id: string } | null } = { open: false, viewing: null }
vi.mock('@renderer/context/workflow-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/context/workflow-context')>()),
  useWorkflow: () => ({ subagents: mockSubagents, openSubagent: mockOpenSubagent }),
}))

// Mock useElapsedTimer
vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  useElapsedTimer: () => null,
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))

describe('SubagentTranscript', () => {
  beforeEach(() => {
    mockSubMessages = []
  })

  it('renders completed subagent with stats', () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Find config files' },
      result: 'Found 3 config files',
      subagent: {
        agentId: 'sub-1',
        status: 'completed',
        totalDurationMs: 15000,
        totalTokens: 5000,
        totalToolUseCount: 3,
      },
    })

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
      />
    )

    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('Find config files')).toBeInTheDocument()
  })

  it('renders model-routed agent types without their internal prefix and hash', () => {
    const tc = createToolCall({
      name: 'Agent',
      input: {
        subagent_type: 'model-gpt-5-5-1iimw9e',
        description: 'Run with another model',
      },
      result: 'Done',
    })

    render(<SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" />)

    expect(screen.getByText('GPT 5.5')).toBeInTheDocument()
    expect(screen.queryByText('model-gpt-5-5-1iimw9e')).not.toBeInTheDocument()
  })

  it('shows stats footer for completed subagent when expanded', async () => {
    const user = userEvent.setup()
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Search' },
      result: 'Done',
      subagent: {
        agentId: 'sub-1',
        status: 'completed',
        totalDurationMs: 15000,
        totalTokens: 5000,
        totalToolUseCount: 3,
      },
    })

    render(
      <SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" />
    )

    // Click to expand
    await user.click(screen.getByText('Explore'))

    expect(screen.getByText(/15s/)).toBeInTheDocument()
    expect(screen.getByText(/5.0k tokens/)).toBeInTheDocument()
    expect(screen.getByText(/3 tool calls/)).toBeInTheDocument()
  })

  it('shows running status when session is active and no result', () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'general-purpose', description: 'Working...' },
      result: undefined,
    })

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: null,
          subagentType: null,
          description: null,
          usage: null,
          lastToolName: null,
        }}
      />
    )

    // Running status is indicated
    expect(screen.getByText('running')).toBeTruthy()
  })

  it('shows a completed tool call as running while the same agent is resumed', () => {
    const tc = createToolCall({
      id: 'agent-tool',
      name: 'Agent',
      input: { subagent_type: 'general-purpose', description: 'Resume UI probe' },
      result: 'FIRST_DONE',
      subagent: { agentId: 'agent-1', status: 'completed' },
    })

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        activeSubagent={{
          parentToolId: 'send-tool',
          agentId: 'agent-1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: 'Running resumed task',
          subagentType: 'general-purpose',
          description: 'Resume UI probe',
          usage: null,
          lastToolName: null,
        }}
      />
    )

    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('Sub-agent is working...')).toBeInTheDocument()
  })

  it('shows a resumed run in the same transcript, with its live output before the saved transcript catches up', () => {
    const tc = createToolCall({
      id: 'agent-tool',
      name: 'Agent',
      input: { subagent_type: 'general-purpose', description: 'Check the changes' },
      result: 'Initial check finished',
      subagent: { agentId: 'agent-1', status: 'completed' },
    })
    mockSubMessages = [createAssistantMessage({ content: { text: 'Initial check finished' } })]
    const { rerender } = render(
      <SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" isSessionActive isCompleted />
    )
    // The whole transcript is shown: the saved text is there once, not repeated as the result.
    expect(screen.getAllByText('Initial check finished')).toHaveLength(1)

    // MessageItem selects this later run by agentId. SendMessage has a new
    // tool id, while the original Agent block and its persisted result stay.
    const resumed: SubagentInfo = {
      parentToolId: 'send-tool',
      agentId: 'agent-1',
      streamingMessage: 'Checking the follow-up now',
      streamingToolUse: { id: 'resumed-bash', name: 'Bash', partialInput: '{"command":"sleep 25"}' },
      progressSummary: null,
      subagentType: 'general-purpose',
      description: 'Check the changes',
      usage: { duration_ms: 5000, total_tokens: 1500, tool_uses: 2 },
      lastToolName: 'Bash',
    }
    const resumedBlock = (
      <SubagentTranscript
        toolCall={tc} sessionId="s-1" agentSlug="agent-1"
        isSessionActive isCompleted={false} activeSubagent={resumed}
      />
    )
    rerender(resumedBlock)

    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('Checking the follow-up now')).toBeInTheDocument()
    expect(screen.getByTestId('sub-streaming-tool')).toHaveTextContent('Bash')
    expect(screen.getByText(/5s · 1.5k tokens · 2 tool calls/)).toBeInTheDocument()

    // A later JSONL refetch must replace, rather than duplicate, the stream.
    mockSubMessages = [...mockSubMessages, createAssistantMessage({
      content: { text: 'Checking the follow-up now' },
      toolCalls: [createToolCall({ id: 'resumed-bash', name: 'Bash', result: undefined })],
    })]
    rerender(<SubagentTranscript
      toolCall={tc} sessionId="s-1" agentSlug="agent-1"
      isSessionActive isCompleted={false} activeSubagent={{ ...resumed }}
    />)
    expect(screen.getAllByText('Checking the follow-up now')).toHaveLength(1)
    expect(screen.queryByTestId('sub-streaming-tool')).not.toBeInTheDocument()
    expect(screen.getByTestId('sub-tool-Bash')).toBeInTheDocument()
  })

  it('renders subagent messages when expanded', async () => {
    const user = userEvent.setup()
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Search' },
      result: 'Done',
      subagent: { agentId: 'sub-1', status: 'completed' },
    })

    mockSubMessages = [
      createAssistantMessage({
        id: 'sub-msg-1',
        content: { text: 'I found the config file.' },
        toolCalls: [createToolCall({ name: 'Read', result: 'file content' })],
      }),
    ]

    render(
      <SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" />
    )

    await user.click(screen.getByText('Explore'))

    expect(screen.getByText('I found the config file.')).toBeInTheDocument()
    expect(screen.getByTestId('sub-tool-Read')).toBeInTheDocument()
  })

  it('passes isSessionActive to in-flight subagent tools so they show running, not cancelled', () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Working' },
      result: undefined,
    })

    // In-flight tool inside the subagent (no result yet)
    mockSubMessages = [
      createAssistantMessage({
        id: 'sub-msg-1',
        content: { text: 'snapshotting' },
        toolCalls: [createToolCall({ name: 'Bash', result: undefined })],
      }),
    ]

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: null,
          subagentType: null,
          description: null,
          usage: null,
          lastToolName: null,
        }}
      />
    )

    // Running subagent auto-expands; the in-flight tool must be told the session
    // is active, otherwise getStatus() resolves it to 'cancelled' (the Ban icon).
    expect(screen.getByTestId('sub-tool-Bash')).toHaveAttribute('data-session-active', 'true')
  })

  it('shows "Sub-agent is working..." when running with no messages', async () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Working' },
      result: undefined,
    })

    mockSubMessages = []

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: null,
          subagentType: null,
          description: null,
          usage: null,
          lastToolName: null,
        }}
      />
    )

    // Running subagent auto-expands
    expect(screen.getByText('Sub-agent is working...')).toBeInTheDocument()
  })

  it('shows streaming message from active subagent', () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Searching' },
      result: undefined,
    })

    mockSubMessages = []

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: 'Found some interesting files...',
          streamingToolUse: null,
          progressSummary: null,
          subagentType: null,
          description: null,
          usage: null,
          lastToolName: null,
        }}
      />
    )

    expect(screen.getByText('Found some interesting files...')).toBeInTheDocument()
  })

  it('shows streaming tool use from active subagent', () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Searching' },
      result: undefined,
    })

    mockSubMessages = []

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: null,
          streamingToolUse: {
            id: 'tc-sub-streaming',
            name: 'Grep',
            partialInput: '{"pattern": "config"}',
          },
          progressSummary: null,
          subagentType: null,
          description: null,
          usage: null,
          lastToolName: null,
        }}
      />
    )

    expect(screen.getByTestId('sub-streaming-tool')).toBeInTheDocument()
  })

  it('renders cancelled status for tool with no result and inactive session', () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Was working' },
      result: undefined,
    })

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive={false}
      />
    )

    // Should not be spinning (not running)
    expect(screen.getByText('Explore')).toBeInTheDocument()
  })

  it('shows resultText from activeSubagent when toolCall.result is not yet available', async () => {
    const user = userEvent.setup()
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Searching' },
      result: undefined,
    })

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        isCompleted
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: null,
          subagentType: null,
          description: null,
          usage: null,
          lastToolName: null,
          resultText: 'Found 3 config files in the workspace.',
        }}
      />
    )

    // isCompleted → status = 'completed', auto-collapsed — expand to see result
    await user.click(screen.getByText('Explore'))

    expect(screen.getByText('Found 3 config files in the workspace.')).toBeInTheDocument()
  })

  it("does not show a background launch's acknowledgement as the agent's result", async () => {
    // Every background subagent (and every fork, which always runs in the
    // background) gets this tool_result at launch; its report is in the
    // transcript or the SSE resultText.
    const user = userEvent.setup()
    mockSubMessages = [createAssistantMessage({ content: { text: 'date -u output: Mon Oct 19' } })]
    const tc = createToolCall({
      name: 'Agent',
      input: { subagent_type: 'fork', description: 'inspect workspace' },
      result: 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: sub-1',
      subagent: { agentId: 'sub-1', status: 'async_launched' },
    })

    render(<SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" />)
    await user.click(screen.getByText('fork'))

    expect(screen.getByText('date -u output: Mon Oct 19')).toBeInTheDocument()
    expect(screen.queryByText(/Async agent launched/)).not.toBeInTheDocument()
  })

  it("shows the SSE result of a background launch that finished in this session", async () => {
    const user = userEvent.setup()
    const tc = createToolCall({
      name: 'Agent',
      input: { subagent_type: 'fork', description: 'inspect workspace' },
      result: 'Async agent launched successfully.\nagentId: sub-1',
      subagent: { agentId: 'sub-1', status: 'async_launched' },
    })

    render(
      <SubagentTranscript
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive
        isCompleted
        activeSubagent={{
          parentToolId: tc.id,
          agentId: 'sub-1',
          streamingMessage: null,
          streamingToolUse: null,
          progressSummary: null,
          subagentType: 'fork',
          description: 'inspect workspace',
          usage: null,
          lastToolName: null,
          resultText: 'The listing had 8 entries.',
        }}
      />
    )
    await user.click(screen.getByText('fork'))

    expect(screen.getByText('The listing had 8 entries.')).toBeInTheDocument()
    expect(screen.queryByText(/Async agent launched/)).not.toBeInTheDocument()
  })

  it('keeps a mermaid fence in live sub-agent text as code and draws it in the settled result', async () => {
    const user = userEvent.setup()
    const tc = createToolCall({ name: 'Task', input: { subagent_type: 'Explore', description: 'Searching' }, result: undefined })
    const fence = '```mermaid\ngraph LR\n  Request --> Response\n```'
    const subagent = {
      parentToolId: tc.id, agentId: 'sub-1', streamingToolUse: null, progressSummary: null,
      subagentType: null, description: null, usage: null, lastToolName: null,
    }

    const live = render(
      <SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" isSessionActive
        activeSubagent={{ ...subagent, streamingMessage: fence }} />
    )
    // Let the lazy diagram chunk settle, so a settled render would have drawn by now.
    await act(async () => { await import('./mermaid-diagram') })
    expect(live.container.querySelector('pre')).toHaveTextContent('Request --> Response')
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
    live.unmount()

    render(
      <SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" isSessionActive isCompleted
        activeSubagent={{ ...subagent, streamingMessage: null, resultText: fence }} />
    )
    await user.click(screen.getByText('Explore'))
    expect(await screen.findByTestId('mermaid-diagram')).toBeInTheDocument()
  })

  it('draws a mermaid fence in a saved sub-agent transcript item', async () => {
    const user = userEvent.setup()
    const tc = createToolCall({ name: 'Task', input: { subagent_type: 'Explore', description: 'Searching' }, result: 'Done', subagent: { agentId: 'sub-1', status: 'completed' } })
    mockSubMessages = [createAssistantMessage({ content: { text: '```mermaid\ngraph LR\n  Saved --> Item\n```' } })]

    render(<SubagentTranscript toolCall={tc} sessionId="s-1" agentSlug="agent-1" />)
    await user.click(screen.getByText('Explore'))
    expect(await screen.findByTestId('mermaid-diagram')).toBeInTheDocument()
  })
})

describe('SubAgentBlock', () => {
  beforeEach(() => {
    mockSubMessages = []
    mockSubagents = { open: false, viewing: null }
    mockOpenSubagent.mockClear()
  })

  it('is one row that opens the transcript in the Subagents tab instead of expanding in place', async () => {
    const tc = createToolCall({
      id: 'agent-tool',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'Find config files' },
      result: 'Found 3 config files\nin two folders',
      subagent: { agentId: 'sub-1', status: 'completed' },
    })
    mockSubMessages = [createAssistantMessage({ content: { text: 'Reading the tree' } })]
    render(<SubAgentBlock toolCall={tc} sessionId="s-1" agentSlug="agent-1" />)

    const row = screen.getByTestId('subagent-row')
    expect(row).toHaveTextContent('Sub-agent:')
    expect(row).toHaveTextContent('Explore')
    expect(row).toHaveTextContent('Find config files')
    expect(screen.getByTestId('status-indicator')).toHaveTextContent('completed')
    // Done, it carries the first line of what the agent reported, and none of its transcript.
    expect(screen.getByTestId('subagent-row-progress')).toHaveTextContent(/^Found 3 config files$/)
    expect(screen.queryByText('Reading the tree')).not.toBeInTheDocument()

    await userEvent.setup().click(row)
    expect(mockOpenSubagent).toHaveBeenCalledWith(tc)
    expect(screen.queryByText('Reading the tree')).not.toBeInTheDocument()
  })

  it('shows what a running subagent is on, and how long it has been going', () => {
    const tc = createToolCall({ id: 'agent-tool', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find config files' }, result: undefined })
    const active: SubagentInfo = {
      parentToolId: 'agent-tool',
      agentId: 'sub-1',
      streamingMessage: 'Looking through the repo',
      streamingToolUse: null,
      progressSummary: null,
      subagentType: 'Explore',
      description: 'Find config files',
      usage: { duration_ms: 12000, total_tokens: 900, tool_uses: 2 },
      lastToolName: 'Grep',
    }
    render(<SubAgentBlock toolCall={tc} sessionId="s-1" agentSlug="agent-1" isSessionActive activeSubagent={active} />)

    expect(screen.getByTestId('subagent-row')).toHaveAttribute('data-status', 'running')
    expect(screen.getByTestId('subagent-row-progress')).toHaveTextContent('Grep · 12s')
    // Its live text belongs to the tab, not to the row.
    expect(screen.queryByText('Looking through the repo')).not.toBeInTheDocument()
  })

  it('marks the row while the Subagents tab is showing its transcript', () => {
    const tc = createToolCall({ id: 'agent-tool', name: 'Agent', input: { subagent_type: 'Explore' }, result: 'Done' })
    mockSubagents = { open: true, viewing: { id: 'agent-tool' } }
    render(<SubAgentBlock toolCall={tc} sessionId="s-1" agentSlug="agent-1" />)
    expect(screen.getByTestId('subagent-row')).toHaveAttribute('data-open', 'true')
  })
})
