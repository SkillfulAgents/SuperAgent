// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActivityCard } from './activity-card'

const SUBAGENT = { id: 'agent-1', name: 'researcher', description: 'Find facts', status: 'running' as const, progressSummary: null }
const TASK = { taskId: 'bg1', startedAt: Date.now(), title: 'Background command', detail: 'npm test' }

describe('ActivityCard rows', () => {
  it('opens a subagent or a background task in the drawer when its row is clicked', async () => {
    const onOpenSubagent = vi.fn()
    const onOpenTask = vi.fn()
    const user = userEvent.setup()
    render(
      <ActivityCard
        statusText="Working"
        orbState="working"
        subagents={[SUBAGENT]}
        backgroundTasks={[TASK]}
        onOpenSubagent={onOpenSubagent}
        onOpenTask={onOpenTask}
      />,
    )
    await user.click(screen.getByTestId('subagent-activity-open'))
    expect(onOpenSubagent).toHaveBeenCalledWith(SUBAGENT)
    await user.click(screen.getByTestId('background-task-open'))
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'bg1' }))
  })

  it('lists other agents this turn called, and opens one whose session is known', async () => {
    const onOpenAgentCall = vi.fn()
    const running = { key: 'helper:s1', name: 'Helper', agent: { slug: 'helper' }, prompt: 'Find facts', status: 'running' as const, sessionId: 's1' }
    const waiting = { key: 'pending:t2', name: 'Writer', agent: { slug: 'writer' }, prompt: 'Draft', status: 'running' as const, sessionId: null }
    const user = userEvent.setup()
    render(<ActivityCard statusText="Working" orbState="working" agentCalls={[running, waiting]} onOpenAgentCall={onOpenAgentCall} />)
    const rows = screen.getAllByTestId('agent-call-activity-row')
    expect(rows.map(row => row.textContent)).toEqual(['Helper Find facts', 'Writer Draft'])
    // A call still waiting for its session has nothing to open yet.
    expect(screen.getAllByTestId('agent-call-activity-open')).toHaveLength(1)
    await user.click(screen.getByTestId('agent-call-activity-open'))
    expect(onOpenAgentCall).toHaveBeenCalledWith(running)
  })

  it('keeps the rows as they were where there is no drawer to open them in', () => {
    render(<ActivityCard statusText="Working" orbState="working" subagents={[SUBAGENT]} backgroundTasks={[TASK]} />)
    expect(screen.queryByTestId('subagent-activity-open')).toBeNull()
    expect(screen.queryByTestId('background-task-open')).toBeNull()
  })
})
