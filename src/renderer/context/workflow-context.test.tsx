// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowProvider, useWorkflow } from './workflow-context'

// Provider derives sessionId from the route unless passed explicitly; stub the route
// so it falls through to the `sessionId` prop the tests drive.
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ view: { kind: 'other' } }),
}))

function Probe() {
  const wf = useWorkflow()
  return (
    <div>
      <div data-testid="open">{String(wf.isOpen)}</div>
      <div data-testid="selected">{wf.selectedRunId ?? 'none'}</div>
      <div data-testid="count">{wf.openWorkflows.length}</div>
      <button onClick={() => wf.openWorkflow('wf_1', 'first')}>open1</button>
      <button onClick={() => wf.openWorkflow('wf_2', 'second')}>open2</button>
      <button onClick={() => wf.close()}>close</button>
    </div>
  )
}

describe('WorkflowContext', () => {
  it('opens to a run, dedupes by runId, switches selection, and closes', () => {
    render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    expect(screen.getByTestId('open')).toHaveTextContent('false')

    fireEvent.click(screen.getByText('open1'))
    expect(screen.getByTestId('open')).toHaveTextContent('true')
    expect(screen.getByTestId('selected')).toHaveTextContent('wf_1')
    expect(screen.getByTestId('count')).toHaveTextContent('1')

    fireEvent.click(screen.getByText('open1'))
    expect(screen.getByTestId('count')).toHaveTextContent('1') // deduped

    fireEvent.click(screen.getByText('open2'))
    expect(screen.getByTestId('count')).toHaveTextContent('2')
    expect(screen.getByTestId('selected')).toHaveTextContent('wf_2')

    fireEvent.click(screen.getByText('close'))
    expect(screen.getByTestId('open')).toHaveTextContent('false')
  })

  it('clears state when the session changes', () => {
    const { rerender } = render(
      <WorkflowProvider sessionId="s1">
        <Probe />
      </WorkflowProvider>
    )
    fireEvent.click(screen.getByText('open1'))
    expect(screen.getByTestId('count')).toHaveTextContent('1')

    rerender(
      <WorkflowProvider sessionId="s2">
        <Probe />
      </WorkflowProvider>
    )
    expect(screen.getByTestId('count')).toHaveTextContent('0')
    expect(screen.getByTestId('open')).toHaveTextContent('false')
    expect(screen.getByTestId('selected')).toHaveTextContent('none')
  })
})
