// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { ComputerUseRequestItem } from './computer-use-request-item'

const baseProps = {
  toolUseId: 'tool-use-1',
  method: 'apps',
  params: {},
  sessionId: 'session-1',
  agentSlug: 'agent-1',
  onComplete: vi.fn(),
}

describe('ComputerUseRequestItem permission labels', () => {
  it('explains read-only access in both the prompt and permission badge', () => {
    render(
      <ComputerUseRequestItem
        {...baseProps}
        permissionLevel="list_apps_windows"
      />
    )

    expect(screen.getByText('Allow the agent to list apps & windows (read-only)?')).toBeInTheDocument()
    expect(screen.getByText('List Apps & Windows (read-only)')).toBeInTheDocument()
  })

  it('uses the self-explanatory shell permission wording', () => {
    render(
      <ComputerUseRequestItem
        {...baseProps}
        method="run"
        permissionLevel="use_host_shell"
      />
    )

    expect(screen.getByText('Allow the agent to run shell commands & scripts?')).toBeInTheDocument()
    expect(screen.getByText('Run Shell Commands & Scripts')).toBeInTheDocument()
    expect(screen.queryByText('Host Shell')).not.toBeInTheDocument()
  })
})
