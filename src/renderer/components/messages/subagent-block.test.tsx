// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SubAgentBlock } from './subagent-block'
import { createToolCall, createAssistantMessage } from '@renderer/test/factories'
import type { ApiToolCall } from '@shared/lib/types/api'

// Mock useSubagentMessages
let mockSubMessages: any[] = []
vi.mock('@renderer/hooks/use-messages', () => ({
  useSubagentMessages: () => ({ data: mockSubMessages }),
}))

// Mock ToolCallItem
vi.mock('./tool-call-item', () => ({
  ToolCallItem: ({ toolCall }: { toolCall: ApiToolCall }) => (
    <div data-testid={`sub-tool-${toolCall.name}`}>{toolCall.name}</div>
  ),
  StreamingToolCallItem: ({ name }: { name: string }) => (
    <div data-testid="sub-streaming-tool">{name}</div>
  ),
}))

// Mock useElapsedTimer
vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  useElapsedTimer: () => null,
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))

describe('SubAgentBlock', () => {
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
      <SubAgentBlock
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
      />
    )

    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('Find config files')).toBeInTheDocument()
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
      <SubAgentBlock toolCall={tc} sessionId="s-1" agentSlug="agent-1" />
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

    const { container } = render(
      <SubAgentBlock
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
        }}
      />
    )

    // Running status shows spinner
    expect(container.querySelector('.animate-spin')).toBeTruthy()
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
      <SubAgentBlock toolCall={tc} sessionId="s-1" agentSlug="agent-1" />
    )

    await user.click(screen.getByText('Explore'))

    expect(screen.getByText('I found the config file.')).toBeInTheDocument()
    expect(screen.getByTestId('sub-tool-Read')).toBeInTheDocument()
  })

  it('shows "Sub-agent is working..." when running with no messages', async () => {
    const tc = createToolCall({
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Working' },
      result: undefined,
    })

    mockSubMessages = []

    render(
      <SubAgentBlock
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
      <SubAgentBlock
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
      <SubAgentBlock
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
      <SubAgentBlock
        toolCall={tc}
        sessionId="s-1"
        agentSlug="agent-1"
        isSessionActive={false}
      />
    )

    // Should not be spinning (not running)
    expect(screen.getByText('Explore')).toBeInTheDocument()
  })
})
