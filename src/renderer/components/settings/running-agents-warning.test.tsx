// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useRunningAgents: vi.fn(),
  useRunningAgentsAction: vi.fn(),
}))

vi.mock('@renderer/hooks/use-running-agents', () => ({
  useRunningAgents: (...args: unknown[]) => mocks.useRunningAgents(...args),
  useRunningAgentsAction: (...args: unknown[]) => mocks.useRunningAgentsAction(...args),
}))

import { RunningAgentsWarning } from './running-agents-warning'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useRunningAgents.mockReturnValue([
    { id: 'agent-1', name: 'Research' },
    { id: 'agent-2', name: 'Release manager' },
  ])
  mocks.useRunningAgentsAction.mockReturnValue({
    mutate: mocks.mutate,
    isPending: false,
    error: null,
  })
})

describe('RunningAgentsWarning', () => {
  it('lists running agent names and runs the configured restart action', async () => {
    const user = userEvent.setup()
    render(
      <RunningAgentsWarning
        runningAgentIds={['agent-1', 'agent-2']}
        action="restart"
        actionLabel="Restart now"
      >
        Restart to apply these changes.
      </RunningAgentsWarning>,
    )

    expect(screen.getByRole('list', { name: 'Running agents' })).toHaveTextContent('Research')
    expect(screen.getByRole('list', { name: 'Running agents' })).toHaveTextContent('Release manager')
    expect(mocks.useRunningAgents).toHaveBeenCalledWith(['agent-1', 'agent-2'])
    expect(mocks.useRunningAgentsAction).toHaveBeenCalledWith('restart')

    await user.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(mocks.mutate).toHaveBeenCalledOnce()
  })

  it('supports the shared stop-all variant and displays inline failures', () => {
    mocks.useRunningAgentsAction.mockReturnValue({
      mutate: mocks.mutate,
      isPending: false,
      error: new Error('Failed to stop 1 running agent.'),
    })

    render(
      <RunningAgentsWarning action="stop" actionLabel="Stop all">
        Stop agents before editing runtime settings.
      </RunningAgentsWarning>,
    )

    expect(screen.getByRole('button', { name: 'Stop all' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to stop 1 running agent.')
    expect(mocks.useRunningAgentsAction).toHaveBeenCalledWith('stop')
  })
})
