// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardHeaderProvider } from '@renderer/context/dashboard-header-context'
import { DashboardHeaderActions } from './dashboard-header-actions'
import { DashboardView } from './dashboard-view'

const mocks = vi.hoisted(() => ({
  agentSlug: 'agent',
  agentStatus: 'running',
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
  openDashboardExternal: vi.fn(),
  isElectron: false,
  targetIsRemote: false,
  ensureCloudDashboardSession: vi.fn(),
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
  isElectron: () => mocks.isElectron,
  openDashboardExternal: mocks.openDashboardExternal,
}))

vi.mock('@renderer/lib/api-target', () => ({
  targetIsRemote: () => mocks.targetIsRemote,
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
    mocks.dashboardStatus = 'crashed'
    mocks.dashboardDescription = ''
    mocks.dashboardStartupPhase = undefined
    mocks.dashboardFirstRun = undefined
    mocks.isElectron = false
    mocks.targetIsRemote = false
    mocks.ensureCloudDashboardSession.mockReset()
    delete window.electronAPI
    mocks.start.mutateAsync.mockResolvedValue({})
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

describe('DashboardView cloud origin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentSlug = 'abc1234567'
    mocks.agentStatus = 'running'
    mocks.dashboardStatus = 'running'
    mocks.dashboardDescription = ''
    mocks.dashboardStartupPhase = undefined
    mocks.dashboardFirstRun = undefined
    mocks.isElectron = true
    mocks.targetIsRemote = true
    mocks.ensureCloudDashboardSession.mockReset()
    window.electronAPI = {
      ensureCloudDashboardSession: mocks.ensureCloudDashboardSession,
    } as unknown as Window['electronAPI']
  })

  it('does not mount the iframe until the session is settled', async () => {
    let resolveSession!: (value: { useCloudOrigin: boolean; origin: string }) => void
    mocks.ensureCloudDashboardSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve
      }),
    )
    renderDashboard('My Agent-abc1234567')
    expect(document.querySelector('iframe')).toBeNull()
    await act(async () => {
      resolveSession({ useCloudOrigin: true, origin: 'https://ws.example.com' })
    })
    await waitFor(() => {
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        'https://ws.example.com/api/agents/abc1234567/artifacts/dashboard/',
      )
    })
  })

  it('stays on the door when the window is driving Local', async () => {
    mocks.targetIsRemote = false
    mocks.ensureCloudDashboardSession.mockResolvedValue({
      useCloudOrigin: true,
      origin: 'https://ws.example.com',
    })
    renderDashboard('My Agent-abc1234567')
    expect(mocks.ensureCloudDashboardSession).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      '/api/agents/abc1234567/artifacts/dashboard/',
    )
  })

  it('switches the iframe to the cloud origin when the session says so', async () => {
    mocks.ensureCloudDashboardSession.mockResolvedValue({
      useCloudOrigin: true,
      origin: 'https://ws.example.com/',
    })
    renderDashboard('My Agent-abc1234567')
    await waitFor(() => {
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
        'https://ws.example.com/api/agents/abc1234567/artifacts/dashboard/',
      )
    })
  })

  it('keeps the door when the session has no cookie', async () => {
    mocks.ensureCloudDashboardSession.mockResolvedValue({
      useCloudOrigin: false,
      origin: 'https://ws.example.com',
    })
    renderDashboard('My Agent-abc1234567')
    await waitFor(() => {
      expect(mocks.ensureCloudDashboardSession).toHaveBeenCalled()
    })
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      '/api/agents/abc1234567/artifacts/dashboard/',
    )
  })

  it('keeps the door when the session payload is rejected', async () => {
    mocks.ensureCloudDashboardSession.mockResolvedValue({ useCloudOrigin: 'yes' })
    renderDashboard('My Agent-abc1234567')
    await waitFor(() => {
      expect(mocks.ensureCloudDashboardSession).toHaveBeenCalled()
    })
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(
      '/api/agents/abc1234567/artifacts/dashboard/',
    )
  })
})

