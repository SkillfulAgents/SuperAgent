// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowProvider, useWorkflow } from './workflow-context'

// Provider derives sessionId from the route unless passed explicitly; stub the route
// so it falls through to the `sessionId` prop the tests drive.
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ view: { kind: 'other' } }),
}))

const AGENT_CALL = { id: 'tool-1', name: 'Agent', input: {} }

function Probe() {
  const wf = useWorkflow()
  return (
    <div>
      <div data-testid="focus">{wf.focus ? `${wf.focus.key}#${wf.focus.seq}` : 'none'}</div>
      <div data-testid="runs">{wf.openWorkflows.map((w) => (w.agentId ? `${w.runId}@${w.agentId}` : w.runId)).join(',')}</div>
      <div data-testid="subagents">{wf.subagents.open ? wf.subagents.viewing?.id ?? 'list' : 'closed'}</div>
      <button onClick={() => wf.openWorkflow('wf_1', 'first')}>open1</button>
      <button onClick={() => wf.openWorkflow('wf_2', 'second')}>open2</button>
      <button onClick={() => wf.closeWorkflow('wf_1')}>close1</button>
      <button onClick={() => wf.viewWorkflowAgent('wf_1', 'a1')}>viewAgent</button>
      <button onClick={() => wf.viewWorkflowAgent('wf_1', null)}>backToRun</button>
      <button onClick={() => wf.openSubagent(AGENT_CALL)}>openSub</button>
      <button onClick={() => wf.viewSubagent(null)}>subList</button>
      <button onClick={() => wf.openSubagents()}>openSubs</button>
      <button onClick={() => wf.closeSubagents()}>closeSubs</button>
    </div>
  )
}

describe('WorkflowContext', () => {
  it('opens a run as a tab, dedupes by runId, and asks for the tab again each time', () => {
    render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    expect(screen.getByTestId('focus')).toHaveTextContent('none')

    fireEvent.click(screen.getByText('open1'))
    expect(screen.getByTestId('runs')).toHaveTextContent('wf_1')
    expect(screen.getByTestId('focus')).toHaveTextContent('workflow:wf_1#1')

    // Opening the run that is already open adds nothing, but still asks for its tab.
    fireEvent.click(screen.getByText('open1'))
    expect(screen.getByTestId('runs')).toHaveTextContent(/^wf_1$/)
    expect(screen.getByTestId('focus')).toHaveTextContent('workflow:wf_1#2')

    fireEvent.click(screen.getByText('open2'))
    expect(screen.getByTestId('runs')).toHaveTextContent('wf_1,wf_2')

    fireEvent.click(screen.getByText('close1'))
    expect(screen.getByTestId('runs')).toHaveTextContent(/^wf_2$/)
  })

  it('shows one agent of a run inside the run\'s tab, and goes back to the run', () => {
    render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    fireEvent.click(screen.getByText('open1'))
    fireEvent.click(screen.getByText('viewAgent'))
    // Still one tab for the run: the agent is shown in it, not beside it.
    expect(screen.getByTestId('runs')).toHaveTextContent(/^wf_1@a1$/)

    fireEvent.click(screen.getByText('backToRun'))
    expect(screen.getByTestId('runs')).toHaveTextContent(/^wf_1$/)

    // Opening the run from the chat shows the run itself, whatever agent was being read.
    fireEvent.click(screen.getByText('viewAgent'))
    fireEvent.click(screen.getByText('open1'))
    expect(screen.getByTestId('runs')).toHaveTextContent(/^wf_1$/)
  })

  it('keeps every subagent in one tab: opened on one of them, back to the list, and closed', () => {
    render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    expect(screen.getByTestId('subagents')).toHaveTextContent('closed')

    fireEvent.click(screen.getByText('openSub'))
    expect(screen.getByTestId('subagents')).toHaveTextContent('tool-1')
    expect(screen.getByTestId('focus')).toHaveTextContent('agent:subagents#1')

    // Back to the list stays in the tab, and asks for nothing.
    fireEvent.click(screen.getByText('subList'))
    expect(screen.getByTestId('subagents')).toHaveTextContent('list')
    expect(screen.getByTestId('focus')).toHaveTextContent('agent:subagents#1')

    fireEvent.click(screen.getByText('openSub'))
    expect(screen.getByTestId('focus')).toHaveTextContent('agent:subagents#2')

    fireEvent.click(screen.getByText('closeSubs'))
    expect(screen.getByTestId('subagents')).toHaveTextContent('closed')
  })

  it('opens the Subagents tab on its list when no subagent was being read', () => {
    render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    fireEvent.click(screen.getByText('openSubs'))
    expect(screen.getByTestId('subagents')).toHaveTextContent('list')
    expect(screen.getByTestId('focus')).toHaveTextContent('agent:subagents#1')
  })

  it('starts a different session empty', () => {
    const { rerender } = render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    fireEvent.click(screen.getByText('open1'))
    fireEvent.click(screen.getByText('openSub'))

    rerender(
      <WorkflowProvider sessionId="s2">
        <Probe />
      </WorkflowProvider>
    )
    expect(screen.getByTestId('runs')).toBeEmptyDOMElement()
    expect(screen.getByTestId('subagents')).toHaveTextContent('closed')
    expect(screen.getByTestId('focus')).toHaveTextContent('none')
  })

  it('keeps a remembered session\'s tabs for when it is opened again', () => {
    const { rerender } = render(
      <WorkflowProvider sessionId="remembered-1" rememberTabs>
        <Probe />
      </WorkflowProvider>
    )
    fireEvent.click(screen.getByText('open1'))
    fireEvent.click(screen.getByText('viewAgent'))
    fireEvent.click(screen.getByText('openSub'))

    rerender(
      <WorkflowProvider sessionId="remembered-2" rememberTabs>
        <Probe />
      </WorkflowProvider>
    )
    expect(screen.getByTestId('runs')).toBeEmptyDOMElement()

    rerender(
      <WorkflowProvider sessionId="remembered-1" rememberTabs>
        <Probe />
      </WorkflowProvider>
    )
    // The run comes back on the agent that was being read, and the Subagents tab on its subagent.
    expect(screen.getByTestId('runs')).toHaveTextContent('wf_1@a1')
    expect(screen.getByTestId('subagents')).toHaveTextContent('tool-1')
    // Coming back restores what was open without asking for any tab again.
    expect(screen.getByTestId('focus')).toHaveTextContent('none')
  })
})
