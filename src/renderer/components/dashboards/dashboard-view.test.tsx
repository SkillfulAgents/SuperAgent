// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardHeaderProvider } from '@renderer/context/dashboard-header-context'
import { DASHBOARD_CONTEXT_MENU_TYPE } from '@shared/lib/dashboard-inspect-schema'
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
  apiFetch: vi.fn(),
  canUse: true,
  createSession: {
    mutateAsync: vi.fn(),
  },
  navigate: vi.fn(),
  inspect: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useCreateSession: () => mocks.createSession,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({
    isRecording: false,
    isConnecting: false,
    isFinalizing: false,
    isSupported: false,
    error: null,
    clearError: () => {},
    startRecording: async () => {},
    stopRecording: async () => undefined,
  }),
  useIsVoiceConfigured: () => false,
}))

vi.mock('@renderer/components/ui/voice-input-button', () => ({
  VoiceInputButton: () => null,
  VoiceInputError: () => null,
}))

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mocks.toastSuccess(...args) },
}))

vi.mock('./comments/dashboard-frame', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./comments/dashboard-frame')>()),
  inspectDashboard: (...args: unknown[]) => mocks.inspect(...args),
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
    canUseAgent: () => mocks.canUse,
  }),
}))

vi.mock('@renderer/components/dashboards/add-to-dock-dialog', () => ({
  AddToDockDialog: () => null,
}))

vi.mock('@renderer/components/dashboards/pending-agent-reviews', () => ({
  PendingAgentReviews: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="pending-agent-reviews" data-read-only={String(!!readOnly)} />,
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

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
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
    mocks.canUse = true
    mocks.start.mutateAsync.mockResolvedValue({})
    mocks.refetchAgent.mockImplementation(async () => ({
      data: {
        slug: mocks.agentSlug,
        status: mocks.refetchedAgentStatus,
      },
    }))
    mocks.apiFetch.mockResolvedValue({ ok: true })
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

  it.each([
    ['running', false, 'true'],
    ['crashed', false, 'true'],
    ['running', true, 'false'],
    ['crashed', true, 'false'],
  ])('on a %s dashboard, canUseAgent=%s shows the agent\'s requests with read-only=%s', (status, canUse, readOnly) => {
    mocks.dashboardStatus = status
    mocks.canUse = canUse
    renderDashboard()
    expect(screen.getByTestId('pending-agent-reviews')).toHaveAttribute('data-read-only', readOnly)
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

  it('shows the toolbar spinner until the first iframe document loads', async () => {
    mocks.dashboardStatus = 'running'
    renderDashboard()
    const frame = document.querySelector('iframe')!

    expect(screen.getByRole('button', { name: 'Loading dashboard' })).toBeDisabled()

    fireEvent.load(frame)
    // The load is only trusted once the async probe confirms it
    await act(async () => {})

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
    await act(async () => {})

    await userEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }))

    expect(screen.getByRole('button', { name: 'Refreshing dashboard' })).toBeDisabled()
    const fresh = document.querySelector('iframe')!
    expect(fresh).not.toBe(frame)

    fireEvent.load(fresh)
    await act(async () => {})

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
    mocks.apiFetch.mockResolvedValue({ ok: true })
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

  it('accepts a document once the probe confirms the dashboard answered', async () => {
    mocks.dashboardStatus = 'running'
    renderDashboard()
    const frame = document.querySelector('iframe')!

    fireEvent.load(frame)
    await act(async () => {})

    // Browsers fire 'load' even for failed navigations, so acceptance goes
    // through a HEAD probe of the same URL.
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/agents/agent/artifacts/dashboard/',
      { method: 'HEAD', cache: 'no-store' },
    )
    expect(document.querySelector('iframe')).toBe(frame)
  })

  it('does not probe a document that loaded before the dashboard was running', async () => {
    renderDashboard()
    const frame = document.querySelector('iframe')!

    fireEvent.load(frame)
    await act(async () => {})

    expect(mocks.apiFetch).not.toHaveBeenCalled()
  })

  it('retries with backoff when the loaded document fails the probe, bounded', async () => {
    vi.useFakeTimers()
    try {
      mocks.dashboardStatus = 'running'
      mocks.apiFetch.mockRejectedValue(new Error('fetch failed'))
      renderDashboard()
      let frame = document.querySelector('iframe')!

      // 3 retries with growing delays
      for (const delay of [1_000, 2_000, 4_000]) {
        fireEvent.load(frame)
        await act(async () => {}) // probe rejects → retry scheduled
        expect(document.querySelector('iframe')).toBe(frame)
        act(() => {
          vi.advanceTimersByTime(delay)
        })
        const next = document.querySelector('iframe')!
        expect(next).not.toBe(frame)
        frame = next
      }

      // Budget exhausted: the 4th failed probe is terminal
      fireEvent.load(frame)
      await act(async () => {})
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(document.querySelector('iframe')).toBe(frame)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DashboardView comments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.agentSlug = 'agent'
    mocks.agentStatus = 'running'
    mocks.refetchedAgentStatus = 'running'
    mocks.dashboardStatus = 'running'
    mocks.dashboardStartupPhase = undefined
    mocks.canUse = true
    mocks.apiFetch.mockResolvedValue({ ok: true })
    mocks.inspect.mockResolvedValue(null)
    mocks.createSession.mutateAsync.mockResolvedValue({ id: 'session-1' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('offers comment mode only to people who can start sessions on the agent', () => {
    mocks.canUse = false
    renderDashboard()
    expect(screen.getByRole('button', { name: 'Open dashboard in new window' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add comment' })).toBeNull()
  })

  it('lays the grid over the dashboard and sends the comment to a background session', async () => {
    const user = userEvent.setup()
    renderDashboard()

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    const overlay = await screen.findByTestId('dashboard-comment-overlay')
    expect(screen.getByRole('button', { name: 'Exit comment mode' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(overlay).getByText('Whole dashboard · click to pin a spot')).toBeVisible()

    fireEvent.click(overlay, { clientX: 10, clientY: 10 })
    expect(within(overlay).getByText('Pinned to this spot · drag or click to move')).toBeVisible()

    await user.type(within(overlay).getByPlaceholderText('What should change?'), 'Make the bars blue')
    await user.click(within(overlay).getByRole('button', { name: 'Send' }))

    expect(mocks.createSession.mutateAsync).toHaveBeenCalledOnce()
    const { agentSlug, message } = mocks.createSession.mutateAsync.mock.calls[0][0] as { agentSlug: string; message: string }
    expect(agentSlug).toBe('agent')
    expect(message).toMatch(/^Make the bars blue\n\n\[Dashboard comment context:\]\n/)
    expect(message).toContain('files in /workspace/artifacts/dashboard/')
    expect(message).toContain('- Pinned at')
    // A browser cannot capture the frame, so the agent is told to look itself.
    expect(message).toContain('No screenshot (this window cannot capture the page)')
    // Once as the overlay opened, once with the pin as it was sent.
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
    expect(mocks.inspect.mock.calls[1][1]).toEqual({ x: expect.any(Number), y: expect.any(Number) })

    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sent to agent', expect.objectContaining({ action: expect.objectContaining({ label: 'View' }) }))
    const { action } = mocks.toastSuccess.mock.calls[0][1] as { action: { onClick: () => void } }
    action.onClick()
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/agents/$slug/sessions/$sessionId', params: { slug: 'agent', sessionId: 'session-1' } })
    await waitFor(() => expect(screen.queryByTestId('dashboard-comment-overlay')).toBeNull())
  })

  it('keeps the comment and says why when the session does not start', async () => {
    const user = userEvent.setup()
    mocks.createSession.mutateAsync.mockRejectedValue(new Error('Agent is offline'))
    renderDashboard()

    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    const overlay = await screen.findByTestId('dashboard-comment-overlay')
    const field = within(overlay).getByPlaceholderText('What should change?')
    await user.type(field, 'Bigger title{Enter}')

    expect(await within(overlay).findByRole('alert')).toHaveTextContent('Agent is offline')
    expect(field).toHaveValue('Bigger title')
    expect(within(overlay).getByRole('button', { name: 'Send' })).toBeEnabled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('leaves comment mode on Escape', async () => {
    const user = userEvent.setup()
    renderDashboard()
    await user.click(screen.getByRole('button', { name: 'Add comment' }))
    await screen.findByTestId('dashboard-comment-overlay')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('dashboard-comment-overlay')).toBeNull())
    expect(screen.getByRole('button', { name: 'Add comment' })).toHaveAttribute('aria-pressed', 'false')
    expect(mocks.createSession.mutateAsync).not.toHaveBeenCalled()
  })

  it('opens its menu on a right-click in the dashboard and pins the comment there', async () => {
    const user = userEvent.setup()
    renderDashboard()
    const frame = document.querySelector('iframe')!
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200))

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: DASHBOARD_CONTEXT_MENU_TYPE, x: 30, y: 40 },
      }))
    })
    await user.click(await screen.findByRole('menuitem', { name: 'Comment here…' }))

    const overlay = await screen.findByTestId('dashboard-comment-overlay')
    expect(within(overlay).getByText('Pinned to this spot · drag or click to move')).toBeVisible()
    await user.type(within(overlay).getByPlaceholderText('What should change?'), 'This one{Enter}')
    await waitFor(() => expect(mocks.createSession.mutateAsync).toHaveBeenCalledOnce())
    expect(mocks.inspect.mock.calls[1][1]).toEqual({ x: 30, y: 40 })
    const { message } = mocks.createSession.mutateAsync.mock.calls[0][0] as { message: string }
    expect(message).toContain('- Pinned at (30, 40) px in the viewport, 10% across and 20% down')
  })

  it('ignores a right-click posted by any window but its own frame', async () => {
    renderDashboard()
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: window,
        data: { type: DASHBOARD_CONTEXT_MENU_TYPE, x: 30, y: 40 },
      }))
    })
    await act(async () => {})
    expect(screen.queryByRole('menuitem', { name: 'Comment here…' })).toBeNull()
  })
})
