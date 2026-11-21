// @vitest-environment jsdom
// A run's tab shows one of its agents in place of the run, with the way back.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const viewWorkflowAgent = vi.fn()
vi.mock('@renderer/context/workflow-context', () => ({ useWorkflow: () => ({ viewWorkflowAgent }) }))
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => ({ workflows: [] }) }))
vi.mock('@renderer/components/messages/tool-call-item', () => ({
  StatusIndicator: ({ status }: { status: string }) => <span data-testid="status">{status}</span>,
}))
vi.mock('./workflow-agent-transcript', () => ({
  WorkflowAgentTranscript: () => <div data-testid="agent-transcript" />,
}))
const tree = {
  runId: 'wf', name: 'deep-research', description: null, expectedAgents: 1,
  phases: [{ title: 'Scope' }],
  totals: { toolCount: 3, tokens: 1200, durationMs: 4000 },
  agents: [{
    agentId: 'a1', label: 'scope', phase: 'Scope', status: 'done', result: 'Three sources found',
    resolved: 'resolved', prompt: 'Find the scope of the question', model: null, tokens: 1200, toolCount: 3, durationMs: 4000,
  }],
}
vi.mock('@renderer/hooks/use-messages', () => ({
  useWorkflowTree: () => ({ data: tree, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }),
  useWorkflowAgentMessages: () => ({ data: [] }),
}))

import { WorkflowTrayContent } from './workflow-tray-content'

describe('a workflow run\'s tab', () => {
  beforeEach(() => viewWorkflowAgent.mockClear())

  it('lists the run\'s agents, and picking one asks to show it in the same tab', async () => {
    render(<WorkflowTrayContent agentSlug="researcher" sessionId="s1" runId="wf" />)
    expect(screen.queryByTestId('workflow-agent-transcript')).toBeNull()

    await userEvent.setup().click(screen.getByTestId('workflow-agent-row'))
    expect(viewWorkflowAgent).toHaveBeenCalledWith('wf', 'a1')
  })

  it('shows the picked agent in place of the run, with its task, its result and the way back', async () => {
    render(<WorkflowTrayContent agentSlug="researcher" sessionId="s1" runId="wf" agentId="a1" />)

    const detail = screen.getByTestId('workflow-agent-transcript')
    expect(detail).toHaveTextContent('scope')
    expect(screen.getByTestId('workflow-agent-task')).toHaveTextContent('Find the scope of the question')
    expect(screen.getByTestId('workflow-agent-result')).toHaveTextContent('Three sources found')
    expect(screen.getByTestId('agent-transcript')).toBeInTheDocument()
    // The run's own list steps aside.
    expect(screen.queryByTestId('workflow-agent-row')).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Back to deep-research' }))
    expect(viewWorkflowAgent).toHaveBeenCalledWith('wf', null)
  })
})
