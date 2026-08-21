// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardHeaderProvider } from '@renderer/context/dashboard-header-context'
import { DashboardHeaderActions } from './dashboard-header-actions'
import { DashboardView } from './dashboard-view'

const mocks = vi.hoisted(() => ({
  agentSlug: 'agent',
  agentStatus: 'running',
  refetchedAgentStatus: 'running',
  dashboardStatus: 'crashed',
  dashboardDescription: '',
  dashboardStartupPhase: undefined as undefined | 'installing-dependencies' | 'starting-server',
  dashboardFirstRun: undefined as boolean | undefined,
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
  refetchAgent: vi.fn(),
  openDashboardExternal: vi.fn(),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({
    data: {
      slug: mocks.agentSlug,
      status: mocks.agentStatus,
    },
    refetch: mocks.refetchAgent,
  }),
  useStartAgent: () => mocks.start,
  useStopAgent: () => mocks.stop,
}))

vi.mock('@renderer/hooks/use-artifacts', () => ({
  useArtifacts: () => ({
    data: [{
      slug: 'dashboard',
      name: 'Dashboard',
      description: mocks.dashboardDescription,
      status: mocks.dashboardStatus,
      port: 0,
      startupPhase: mocks.dashboardStartupPhase,
      firstRun: mocks.dashboardFirstRun,
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

function DashboardHarness({ agentSlug = 'agent' }: { agentSlug?: string }) {
  return (
    <DashboardHeaderProvider>
      <DashboardHeaderActions agentSlug={agentSlug} dashboardSlug="dashboard" />
      <DashboardView agentSlug={agentSlug} dashboardSlug="dashboard" />
    </DashboardHeaderProvider>
  )
}

function renderDashboard(agentSlug = 'agent') {
  return render(<DashboardHarness agentSlug={agentSlug} />)
}

describe('DashboardView restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentSlug = 'agent'
    mocks.agentStatus = 'running'
    mocks.refetchedAgentStatus = 'running'
    mocks.dashboardStatus = 'crashed'
    mocks.dashboardDescription = ''
    mocks.dashboardStartupPhase = undefined
    mocks.dashboardFirstRun = undefined
    mocks.start.mutateAsync.mockResolvedValue({})
    mocks.refetchAgent.mockImplementation(async () => ({
      data: {
        slug: mocks.agentSlug,
        status: mocks.refetchedAgentStatus,
      },
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wakes a sleeping agent on visibility return even when its cached status is stale', async () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    mocks.dashboardStatus = 'running'

    const view = renderDashboard()
    expect(mocks.start.mutate).not.toHaveBeenCalled()

    visibilityState = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    // The visibility event can precede delivery of the stopped status. Keep
    // the rendered cache stale and let the foreground refetch discover sleep.
    mocks.refetchedAgentStatus = 'stopped'
    view.rerender(<DashboardHarness />)
    expect(mocks.start.mutate).not.toHaveBeenCalled()

    visibilityState = 'visible'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))

    expect(mocks.refetchAgent).toHaveBeenCalledOnce()
    expect(mocks.start.mutate).toHaveBeenCalledOnce()
    expect(mocks.start.mutate).toHaveBeenCalledWith('agent')
  })

  it('does not undo auto-sleep while the dashboard tab remains hidden', () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    mocks.dashboardStatus = 'running'

    const view = renderDashboard()
    visibilityState = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    mocks.agentStatus = 'stopped'
    mocks.dashboardStatus = 'stopped'
    view.rerender(<DashboardHarness />)

    expect(mocks.start.mutate).not.toHaveBeenCalled()
    expect(mocks.refetchAgent).not.toHaveBeenCalled()
  })

  it('does not auto-start a second time while a deliberate stop is pending', async () => {
    let finishStop: () => void = () => {}
    mocks.stop.mutateAsync.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishStop = resolve
      }),
    )

    const view = renderDashboard()
    await userEvent.click(screen.getByRole('button', { name: 'Restart agent' }))

    expect(mocks.stop.mutateAsync).toHaveBeenCalledOnce()

    mocks.agentStatus = 'stopped'
    view.rerender(<DashboardHarness />)

    expect(mocks.start.mutate).not.toHaveBeenCalled()

    await act(async () => finishStop())

    expect(mocks.start.mutateAsync).toHaveBeenCalledOnce()
  })

  it('renders the first-run dependency installation state', () => {
    mocks.dashboardStatus = 'starting'
    mocks.dashboardStartupPhase = 'installing-dependencies'
    mocks.dashboardFirstRun = true

    renderDashboard()

    expect(screen.getByText('Preparing dashboard for first use…')).toBeInTheDocument()
    expect(screen.getByText('Installing dependencies. This only happens once.')).toBeInTheDocument()
  })

  it('shows a running dashboard without waiting for the iframe load event', () => {
    mocks.dashboardStatus = 'running'
    const frame = () => document.querySelector('iframe')
    const waiting = () => screen.queryByText('Waiting for dashboard…')

    const view = renderDashboard()
    expect(frame()).not.toBeNull()
    expect(waiting()).toBeNull()

    // The agent leaves running through a control outside this view.
    mocks.agentStatus = 'stopped'
    view.rerender(<DashboardHarness />)
    expect(frame()).toBeNull()

    mocks.agentStatus = 'running'
    view.rerender(<DashboardHarness />)

    expect(frame()).not.toBeNull()
    expect(waiting()).toBeNull()
  })

  it('shows the toolbar spinner until the first iframe document loads', () => {
    mocks.dashboardStatus = 'running'
    renderDashboard()
    const frame = document.querySelector('iframe')!

    expect(screen.getByRole('button', { name: 'Loading dashboard' })).toBeDisabled()

    fireEvent.load(frame)

    expect(screen.getByRole('button', { name: 'Refresh dashboard' })).not.toBeDisabled()
  })

  it('uses the canonical agent id for the mounted dashboard URL', () => {
    mocks.agentSlug = 'abc1234567'
    mocks.dashboardStatus = 'running'

    renderDashboard('My Agent-abc1234567')

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      '/api/agents/abc1234567/artifacts/dashboard/',
    )
  })

  it('shows refresh progress until the new iframe document loads', async () => {
    mocks.dashboardStatus = 'running'
    renderDashboard()
    const frame = document.querySelector('iframe')!
    fireEvent.load(frame)

    await userEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }))

    expect(screen.getByRole('button', { name: 'Refreshing dashboard' })).toBeDisabled()

    fireEvent.load(frame)

    expect(screen.getByRole('button', { name: 'Refresh dashboard' })).not.toBeDisabled()
  })

  it('moves dashboard actions into the shared header and omits the description chrome', async () => {
    mocks.dashboardStatus = 'running'
    mocks.dashboardDescription = 'Day-by-day calorie and macro tracking'
    renderDashboard()

    expect(screen.getByTestId('dashboard-header-actions')).toBeInTheDocument()
    expect(screen.queryByText(mocks.dashboardDescription)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Open dashboard in new window' }))
    expect(mocks.openDashboardExternal).toHaveBeenCalledWith('agent', 'dashboard', 'Dashboard')
  })
})

describe('DashboardView optimistic mount and retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentSlug = 'agent'
    mocks.agentStatus = 'running'
    mocks.dashboardStatus = 'starting'
    mocks.dashboardDescription = ''
    mocks.dashboardStartupPhase = 'starting-server'
    mocks.dashboardFirstRun = undefined
  })

  it('mounts the iframe behind the status overlay while the server is starting', () => {
    renderDashboard()

    expect(document.querySelector('iframe')).not.toBeNull()
    expect(screen.getByText('Waiting for dashboard…')).toBeInTheDocument()
  })

  it('does not mount the iframe during dependency installation', () => {
    mocks.dashboardStartupPhase = 'installing-dependencies'

    renderDashboard()

    expect(document.querySelector('iframe')).toBeNull()
  })

  it('drops the overlay once the dashboard reports running', () => {
    const view = renderDashboard()
    expect(screen.getByText('Waiting for dashboard…')).toBeInTheDocument()

    mocks.dashboardStatus = 'running'
    view.rerender(<DashboardHarness />)

    expect(screen.queryByText('Waiting for dashboard…')).toBeNull()
    expect(document.querySelector('iframe')).not.toBeNull()
  })

  it('refetches a document that finished loading before the dashboard was running', () => {
    const view = renderDashboard()
    const early = document.querySelector('iframe')!
    fireEvent.load(early)

    mocks.dashboardStatus = 'running'
    view.rerender(<DashboardHarness />)

    const current = document.querySelector('iframe')!
    expect(current).not.toBe(early)
  })

  it('keeps a document loaded after running was already reported (no spurious reload)', () => {
    mocks.dashboardStatus = 'running'
    const view = renderDashboard()
    const frame = document.querySelector('iframe')!
    fireEvent.load(frame)

    view.rerender(<DashboardHarness />)

    expect(document.querySelector('iframe')).toBe(frame)
  })

  it('retries a network-failed load with backoff, bounded', () => {
    vi.useFakeTimers()
    try {
      mocks.dashboardStatus = 'running'
      renderDashboard()
      const first = document.querySelector('iframe')!
      fireEvent.error(first)

      // Not yet — retry is delayed
      expect(document.querySelector('iframe')).toBe(first)
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      const second = document.querySelector('iframe')!
      expect(second).not.toBe(first)

      // Exhaust the budget: 3 retries total, the 4th error is terminal
      let frame = second
      for (const delay of [2_000, 4_000]) {
        fireEvent.error(frame)
        act(() => {
          vi.advanceTimersByTime(delay)
        })
        const next = document.querySelector('iframe')!
        expect(next).not.toBe(frame)
        frame = next
      }
      fireEvent.error(frame)
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(document.querySelector('iframe')).toBe(frame)
    } finally {
      vi.useRealTimers()
    }
  })
})
