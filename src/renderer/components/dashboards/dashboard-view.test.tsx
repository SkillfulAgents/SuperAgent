// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardView } from './dashboard-view'

const mocks = vi.hoisted(() => ({
  agentSlug: 'agent',
  agentStatus: 'running',
  dashboardStatus: 'crashed',
  start: {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  },
  stop: {
    mutateAsync: vi.fn(),
    isPending: false,
  },
  openDashboardExternal: vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({
    data: {
      slug: mocks.agentSlug,
      status: mocks.agentStatus,
    },
  }),
  useStartAgent: () => mocks.start,
  useStopAgent: () => mocks.stop,
}))

vi.mock('@renderer/hooks/use-artifacts', () => ({
  useArtifacts: () => ({
    data: [{
      slug: 'dashboard',
      name: 'Dashboard',
      description: '',
      status: mocks.dashboardStatus,
      port: 0,
    }],
  }),
}))

vi.mock('@renderer/hooks/use-keep-alive', () => ({
  useKeepAlive: vi.fn(),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canUseAgent: () => true,
  }),
}))

vi.mock('@renderer/components/dashboards/add-to-dock-dialog', () => ({
  AddToDockDialog: () => null,
}))

vi.mock('@renderer/components/dashboards/pending-agent-reviews', () => ({
  PendingAgentReviews: () => null,
}))

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => '',
  getPlatform: () => 'web',
  isElectron: () => false,
  openDashboardExternal: mocks.openDashboardExternal,
}))

vi.mock('@renderer/lib/dashboard-utils', () => ({
  openDashboardExternal: vi.fn(),
}))

vi.mock('@renderer/lib/perf', () => ({
  useRenderTracker: vi.fn(),
}))

describe('DashboardView restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentSlug = 'agent'
    mocks.agentStatus = 'running'
    mocks.dashboardStatus = 'crashed'
    mocks.start.mutateAsync.mockResolvedValue({})
  })

  it('does not auto-start a second time while a deliberate stop is pending', async () => {
    let finishStop: () => void = () => {}
    mocks.stop.mutateAsync.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishStop = resolve
      }),
    )

    const view = render(
      <DashboardView agentSlug="agent" dashboardSlug="dashboard" />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Restart agent' }))

    expect(mocks.stop.mutateAsync).toHaveBeenCalledOnce()

    mocks.agentStatus = 'stopped'
    view.rerender(<DashboardView agentSlug="agent" dashboardSlug="dashboard" />)

    expect(mocks.start.mutate).not.toHaveBeenCalled()

    await act(async () => finishStop())

    expect(mocks.start.mutateAsync).toHaveBeenCalledOnce()
  })

  it('waits for the new document when the frame remounts after the agent left running', () => {
    mocks.dashboardStatus = 'running'
    const frame = () => document.querySelector('iframe')
    const waiting = () => screen.queryByText('Waiting for dashboard…')

    const view = render(
      <DashboardView agentSlug="agent" dashboardSlug="dashboard" />,
    )
    fireEvent.load(frame()!)
    expect(waiting()).toBeNull()

    // The agent leaves running through a control outside this view.
    mocks.agentStatus = 'stopped'
    view.rerender(<DashboardView agentSlug="agent" dashboardSlug="dashboard" />)
    expect(frame()).toBeNull()

    mocks.agentStatus = 'running'
    view.rerender(<DashboardView agentSlug="agent" dashboardSlug="dashboard" />)

    expect(waiting()).not.toBeNull()
  })

  it('uses the canonical agent id for the mounted dashboard URL', () => {
    mocks.agentSlug = 'abc1234567'
    mocks.dashboardStatus = 'running'

    render(
      <DashboardView agentSlug="My Agent-abc1234567" dashboardSlug="dashboard" />,
    )

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      '/api/agents/abc1234567/artifacts/dashboard/',
    )
  })
})
