// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowBlock } from './workflow-block'
import { createToolCall } from '@renderer/test/factories'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

// StatusIndicator → expose the status string for assertions
vi.mock('./tool-call-item', () => ({
  StatusIndicator: ({ status }: { status: string }) => (
    <span data-testid="status-indicator">{status}</span>
  ),
}))

vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
}))

const mockOpenWorkflow = vi.fn()
vi.mock('@renderer/context/workflow-context', () => ({
  useWorkflow: () => ({ openWorkflow: mockOpenWorkflow }),
}))

function makeActive(overrides: Partial<SubagentInfo>): SubagentInfo {
  return {
    parentToolId: 'wf-tool-1',
    agentId: 'wk2hahfwt',
    streamingMessage: null,
    streamingToolUse: null,
    progressSummary: null,
    subagentType: null,
    description: null,
    usage: null,
    lastToolName: null,
    resultText: null,
    ...overrides,
  }
}

const SCRIPT = `export const meta = { name: 'capture-probe', phases: [] }\nphase('Scan')`

describe('WorkflowBlock', () => {
  it('stays running while the workflow is active even after the session goes idle', () => {
    // Regression: a workflow is a background task that outlives the launch turn.
    // session goes idle (isSessionActive=false) while the workflow keeps running —
    // it must NOT flip to "completed" until subagent_completed (isCompleted) fires.
    const tc = createToolCall({ id: 'wf-tool-1', name: 'Workflow', input: { script: SCRIPT } })
    const active = makeActive({
      description: 'Minimal 2-phase probe',
      lastToolName: 'word-beta',
      usage: { total_tokens: 8846, tool_uses: 0, duration_ms: 1600 },
    })

    render(
      <WorkflowBlock toolCall={tc} activeSubagent={active} isCompleted={false} />
    )

    expect(screen.getByText('Minimal 2-phase probe')).toBeInTheDocument()
    expect(screen.getByText('word-beta')).toBeInTheDocument() // current agent
    expect(screen.getByTestId('status-indicator')).toHaveTextContent('running')
    expect(screen.getByText(/8\.8k tokens/)).toBeInTheDocument()
  })

  it('renders a completed workflow once subagent_completed has fired', () => {
    const tc = createToolCall({ id: 'wf-tool-1', name: 'Workflow', input: { script: SCRIPT } })
    const active = makeActive({ description: 'Minimal 2-phase probe', lastToolName: 'concat' })

    render(
      <WorkflowBlock toolCall={tc} activeSubagent={active} isCompleted />
    )

    expect(screen.getByTestId('status-indicator')).toHaveTextContent('completed')
    // current-agent pointer is only shown while running
    expect(screen.queryByText('concat')).not.toBeInTheDocument()
  })

  it('falls back to the script meta.name when no live description is available (e.g. after reload)', () => {
    const tc = createToolCall({ id: 'wf-tool-1', name: 'Workflow', input: { script: SCRIPT } })

    render(
      <WorkflowBlock toolCall={tc} activeSubagent={null} isCompleted={false} />
    )

    expect(screen.getByText('capture-probe')).toBeInTheDocument()
    expect(screen.getByTestId('status-indicator')).toHaveTextContent('completed')
  })

  it('opens the drawer to the run when clicked (runId parsed from the tool result)', () => {
    mockOpenWorkflow.mockClear()
    const tc = createToolCall({
      id: 'wf-tool-1',
      name: 'Workflow',
      input: { script: SCRIPT },
      result: { status: 'async_launched', runId: 'wf_abc-123', workflowName: 'capture-probe' },
    })

    render(<WorkflowBlock toolCall={tc} activeSubagent={null} isCompleted />)

    fireEvent.click(screen.getByTitle('View workflow agents'))
    expect(mockOpenWorkflow).toHaveBeenCalledWith('wf_abc-123', 'capture-probe')
  })

  it('is not clickable when no runId can be resolved', () => {
    const tc = createToolCall({ id: 'wf-tool-1', name: 'Workflow', input: { script: SCRIPT }, result: 'hello\n' })
    render(<WorkflowBlock toolCall={tc} activeSubagent={null} isCompleted />)
    expect(screen.queryByTitle('View workflow agents')).not.toBeInTheDocument()
  })
})
