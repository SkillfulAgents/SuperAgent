// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardView } from './dashboard-view'

const mocks = vi.hoisted(() => ({
  agentStatus: 'running',
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
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({
    data: {
      slug: 'agent',
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
      status: 'crashed',
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
    mocks.agentStatus = 'running'
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
})
