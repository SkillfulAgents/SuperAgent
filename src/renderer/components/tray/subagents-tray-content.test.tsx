// @vitest-environment jsdom
// The Subagents tab: one list of the session's subagents, working ones first,
// that shows one subagent's transcript in place and goes back.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAssistantMessage, createToolCall } from '@renderer/test/factories'
import type { ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

const viewSubagent = vi.fn()
let tab: { open: boolean; viewing: ApiToolCall | null }
vi.mock('@renderer/context/workflow-context', () => ({
  useWorkflow: () => ({ subagents: tab, viewSubagent }),
}))
let stream: { activeSubagents: SubagentInfo[]; completedSubagents: Set<string> | null; isActive: boolean }
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => stream }))
let messages: unknown[] | undefined
vi.mock('@renderer/hooks/use-messages', () => ({ useMessages: () => ({ data: messages }) }))
vi.mock('@renderer/components/messages/subagent-block', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/components/messages/subagent-block')>()),
  SubagentTranscript: ({ toolCall, onBack }: { toolCall: ApiToolCall; onBack?: () => void }) => (
    <div data-testid="transcript" data-call={toolCall.id}>
      <button onClick={onBack}>All subagents</button>
    </div>
  ),
}))

import { SubagentsTrayContent } from './subagents-tray-content'

const scan = createToolCall({ id: 'scan', name: 'Agent', input: { subagent_type: 'Explore', description: 'Scan the repo' }, result: undefined })
const history = createToolCall({
  id: 'history', name: 'Agent', input: { subagent_type: 'Explore', description: 'Read the history' },
  result: 'Found the commit', subagent: { agentId: 'sub-history', status: 'completed', totalDurationMs: 21000 },
})
const card = createToolCall({
  id: 'card', name: 'Task', input: { subagent_type: 'general-purpose', description: 'Check the card' },
  result: 'Could not open it', isError: true, subagent: { agentId: 'sub-card', status: 'completed', totalDurationMs: 4000 },
})
const working: SubagentInfo = {
  parentToolId: 'scan', agentId: 'sub-scan', streamingMessage: null, streamingToolUse: null, progressSummary: null,
  subagentType: 'Explore', description: 'Scan the repo',
  usage: { duration_ms: 6000, total_tokens: 900, tool_uses: 2 }, lastToolName: 'Grep',
}

function renderTab() {
  return render(<SubagentsTrayContent agentSlug="agent-1" sessionId="s-1" />)
}

describe('SubagentsTrayContent', () => {
  beforeEach(() => {
    viewSubagent.mockClear()
    tab = { open: true, viewing: null }
    stream = { activeSubagents: [working], completedSubagents: null, isActive: true }
    messages = [
      createAssistantMessage({ toolCalls: [history, createToolCall({ id: 'bash', name: 'Bash', result: 'ok' })] }),
      createAssistantMessage({ toolCalls: [card, scan] }),
    ]
  })

  it('lists every subagent of the session, the working ones first and the latest finished one leading the rest', () => {
    renderTab()

    const active = within(screen.getByTestId('subagents-active'))
    expect(active.getByText('Active · 1')).toBeInTheDocument()
    const row = active.getByTestId('subagents-list-row')
    expect(row).toHaveTextContent('Scan the repo')
    // What it is on now, and how long it has been going.
    expect(row).toHaveTextContent('Working · Grep')
    expect(row).toHaveTextContent('6s')

    const done = within(screen.getByTestId('subagents-done'))
    expect(done.getByText('Done · 2')).toBeInTheDocument()
    const finished = done.getAllByTestId('subagents-list-row')
    expect(finished.map(r => r.getAttribute('data-status'))).toEqual(['error', 'completed'])
    expect(finished[0]).toHaveTextContent('Check the card')
    expect(finished[0]).toHaveTextContent('Failed')
    expect(finished[1]).toHaveTextContent('Read the history')
    expect(finished[1]).toHaveTextContent('21s')
    // Other tool calls are not subagents.
    expect(screen.getAllByTestId('subagents-list-row')).toHaveLength(3)
  })

  it('shows one subagent\'s transcript in place of the list, and goes back', async () => {
    const user = userEvent.setup()
    const view = renderTab()
    await user.click(screen.getByText('Read the history'))
    expect(viewSubagent).toHaveBeenCalledWith(history)

    tab = { open: true, viewing: history }
    view.rerender(<SubagentsTrayContent agentSlug="agent-1" sessionId="s-1" />)
    expect(screen.getByTestId('transcript')).toHaveAttribute('data-call', 'history')
    expect(screen.queryByTestId('subagents-list')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'All subagents' }))
    expect(viewSubagent).toHaveBeenLastCalledWith(null)
  })

  it('shows a subagent opened before the transcript has saved its call', () => {
    const fresh = createToolCall({ id: 'fresh', name: 'Agent', input: {}, result: undefined })
    tab = { open: true, viewing: fresh }
    renderTab()
    expect(screen.getByTestId('transcript')).toHaveAttribute('data-call', 'fresh')
  })

  it('says so when the session has launched no subagents', () => {
    messages = []
    stream = { activeSubagents: [], completedSubagents: null, isActive: false }
    renderTab()
    expect(screen.getByText('No subagents in this session yet.')).toBeInTheDocument()
  })
})
