// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createPortal } from 'react-dom'

// ============================================================================
// AgentCard component tests (rendered via HomePage)
// ============================================================================

// Mock all dependencies for HomePage rendering

const {
  mockUseNotableSessions,
  mockApiFetch,
  mockHomeCardHealthData,
  mockUserSettingsData,
  mockUpdateSettingsMutate,
  mockToastError,
  mockUseIsMobile,
} = vi.hoisted(() => ({
  mockUseNotableSessions: vi.fn<() => { data: Array<Record<string, unknown>> }>(() => ({ data: [] })),
  mockApiFetch: vi.fn(),
  mockHomeCardHealthData: vi.fn<() => Record<string, unknown>>(),
  mockUserSettingsData: vi.fn<() => Record<string, unknown> | null>(() => null),
  mockUpdateSettingsMutate: vi.fn(),
  mockToastError: vi.fn(),
  mockUseIsMobile: vi.fn(() => false),
}))

vi.mock('@shared/lib/utils/cn', () => ({
  cn: (...args: unknown[]) => {
    const classes: string[] = []
    for (const arg of args) {
      if (typeof arg === 'string') classes.push(arg)
      else if (typeof arg === 'object' && arg !== null) {
        for (const [key, value] of Object.entries(arg)) {
          if (value) classes.push(key)
        }
      }
    }
    return classes.join(' ')
  },
}))

vi.mock('@renderer/context/search-context', () => ({
  useSearch: () => ({ open: false, openSearch: vi.fn(), closeSearch: vi.fn() }),
}))

// HomePage reads the cards⇄graph view from the URL (router search params) and
// navigates to switch it — no real router mounts here, so both hooks are
// stubbed (same pattern as app-sidebar.test.tsx).
const mockRouteSearch = vi.fn<() => Record<string, unknown>>(() => ({}))
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearch: () => mockRouteSearch(),
  }
})

vi.mock('@renderer/hooks/use-sessions', () => ({
  useNotableSessions: mockUseNotableSessions,
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const mockAgentsData = vi.fn()
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => mockAgentsData(),
  useStartAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useStopAgent: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: mockUserSettingsData() }),
  useUpdateUserSettings: () => ({ mutate: mockUpdateSettingsMutate, isPending: false }),
}))

vi.mock('@renderer/lib/agent-ordering', () => ({
  applyAgentOrder: (agents: unknown[]) => agents,
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({
    children,
    additionalOptions,
    onArrange,
    disableTouchLongPress,
  }: {
    children: React.ReactNode
    additionalOptions?: React.ReactNode
    onArrange?: () => void
    disableTouchLongPress?: boolean
  }) => (
    <div
      data-testid="agent-context-trigger"
      data-touch-long-press-disabled={disableTouchLongPress || undefined}
    >
      {children}
      {additionalOptions && createPortal(additionalOptions, document.body)}
      {onArrange && (
        <button type="button" data-testid="agent-menu-arrange" onClick={onArrange}>
          Arrange
        </button>
      )}
    </div>
  ),
}))


vi.mock('@renderer/hooks/use-create-untitled-agent', () => ({
  useCreateUntitledAgent: () => ({
    createUntitledAgent: vi.fn(),
    isPending: false,
  }),
  UNTITLED_AGENT_NAME: 'Untitled',
}))

vi.mock('@renderer/components/ui/sidebar', () => ({
  SidebarTrigger: () => <button>sidebar</button>,
  useSidebar: () => ({ state: 'expanded' }),
}))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div data-testid="popover-content">{children}</div>,
}))

vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenuSwitchItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: React.ReactNode
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    >
      {children}
    </button>
  ),
}))

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

vi.mock('@renderer/hooks/use-mobile', () => ({
  useIsMobile: mockUseIsMobile,
}))

vi.mock('sonner', () => ({
  toast: { error: mockToastError },
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getPlatform: () => 'web',
  getApiBaseUrl: () => '',
}))

// Keep the lazily loaded graph (xyflow + d3-force) out of jsdom; tests only
// care whether HomePage mounts it or the empty state.
vi.mock('./graph/agent-graph', () => ({
  AgentGraph: () => <div data-testid="agent-graph-stub" />,
}))

// Import after mocks
import { HomePage } from './home-page'

beforeEach(() => {
  // Halftone intentionally owns its canvas mock in its focused test file.
  // Homepage tests only need the no-context bail path.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeAgent(overrides = {}) {
  return {
    slug: 'test-agent',
    displaySlug: 'test-agent',
    name: 'Test Agent',
    description: 'A test description',
    createdAt: new Date('2026-01-01'),
    status: 'running' as const,
    containerPort: 3000,
    hasActiveSessions: false,
    hasSessionsAwaitingInput: false,
    lastActivityAt: null as Date | null,
    dashboards: [] as Array<{ slug: string; name: string; hasScreenshot?: boolean }>,
    ...overrides,
  }
}

describe('HomePage AgentCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T12:00:00Z'))
    vi.clearAllMocks()
    mockHomeCardHealthData.mockReturnValue({
      days: 14,
      generatedAt: '2026-03-26T12:00:00.000Z',
      crons: [],
      webhooks: [],
      cronByTaskId: {},
      webhookByTriggerId: {},
    })
    mockApiFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => mockHomeCardHealthData(),
    }))
    mockUserSettingsData.mockReturnValue(null)
    mockUseIsMobile.mockReturnValue(false)
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('renders agent name without the description (compact card)', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent()],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
    expect(screen.queryByText('A test description')).not.toBeInTheDocument()
  })

  it('renders last worked time when lastActivityAt is set', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ lastActivityAt: new Date('2026-03-26T09:00:00Z') })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('Last run about 3 hours ago')).toBeInTheDocument()
  })

  it('does not render last worked when lastActivityAt is null', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ lastActivityAt: null })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it('renders a dashboard card per dashboard alongside the agent card', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        dashboards: [
          { slug: 'sales', name: 'Sales' },
          { slug: 'metrics', name: 'Metrics', hasScreenshot: true },
        ],
      })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    // Each dashboard tile is an "Open app" screenshot card; agent cards aren't.
    expect(screen.getAllByText('Open app').length).toBeGreaterThanOrEqual(2)
    for (const link of screen.getAllByRole('link', { name: 'Open app' })) {
      expect(link).toHaveAttribute('draggable', 'false')
      expect(link).toHaveAttribute('data-widget-drag-surface')
    }
  })

  it('renders a screenshot img when hasScreenshot is true', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        dashboards: [{ slug: 'sales', name: 'Sales', hasScreenshot: true }],
      })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    const img = document.querySelector('img[src*="/artifacts/sales/screenshot.png"]')
    expect(img).toBeTruthy()
  })

  it('shows a placeholder icon when a dashboard has no screenshot', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        dashboards: [{ slug: 'sales', name: 'Sales' }],
      })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    const img = document.querySelector('img[src*="/screenshot.png"]')
    expect(img).toBeNull()
  })

  it('renders no dashboard cards when the dashboard list is empty', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboards: [] })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    // Only the agent card should be present — no dashboard screenshot img.
    expect(document.querySelector('img[src*="/screenshot.png"]')).toBeNull()
  })

  it('shows empty state when no agents exist', () => {
    mockAgentsData.mockReturnValue({
      data: [],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    const empty = screen.getByTestId('home-empty-state')
    expect(screen.getByRole('button', { name: /Create your first agent/ })).toBeInTheDocument()
    // The heading was dropped — the ghost board and the live cell's button
    // are the whole message.
    expect(screen.queryByText(/haven’t created any agents/)).not.toBeInTheDocument()
    // The colour bloom is a decorative sibling layer behind the glass card
    // (home-empty-clouds.tsx), never a wrapper around the text.
    expect(empty.querySelector('[data-testid="home-empty-clouds"]')).not.toBeNull()
    // The ghost board sits outside the dialog block, anchored to the section.
    expect(screen.getByTestId('home-empty-skeleton')).toBeInTheDocument()
  })

  it('drops the section header on the empty state, keeping it while loading', () => {
    mockAgentsData.mockReturnValue({ data: [], isLoading: false })
    const { unmount } = renderWithProviders(<HomePage />)
    // No title, arrange menu, or New Agent button competing with the empty
    // state's own call to action.
    expect(screen.queryByText('Your Agents')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^New Agent$/ })).not.toBeInTheDocument()
    unmount()

    // Still shown while loading, so resolving to a populated board doesn't
    // shift the layout.
    mockAgentsData.mockReturnValue({ data: [], isLoading: true })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('Your Agents')).toBeInTheDocument()
  })

  it('renders last activity with dashboard summaries', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        lastActivityAt: new Date('2026-03-26T11:00:00Z'),
        dashboards: [{ slug: 'overview', name: 'Overview' }],
      })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('Last run about 1 hour ago')).toBeInTheDocument()
  })

  it('surfaces the aggregated activity status on the card indicator', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ hasActiveSessions: true, hasSessionsAwaitingInput: true })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    // The status chip is the single accessible announcement; the decorative
    // dot matrix must not expose its internal enum.
    expect(screen.getByText('Needs input')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'awaiting_input' })).not.toBeInTheDocument()
  })

  it('uses a real link for card navigation and keeps notification actions reachable', () => {
    mockUseNotableSessions.mockReturnValue({
      data: [
        {
          id: 'session-1',
          name: 'Test Agent Review',
          hasUnreadNotifications: true,
          lastActivityAt: new Date('2026-03-26T11:55:00Z'),
        },
      ],
    })
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ hasUnreadNotifications: true })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)

    const cardLink = screen.getByRole('link', { name: 'Open Test Agent' })
    expect(cardLink.tagName).toBe('A')
    expect(cardLink).toHaveAttribute('draggable', 'false')
    expect(cardLink).toHaveAttribute('data-widget-drag-surface')
    expect(screen.getByRole('button', { name: 'Mark as read' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open session' })).toBeVisible()
  })

  it('uses the notable-session fast path for cards with live or unread work', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ hasUnreadNotifications: true })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)

    expect(mockUseNotableSessions).toHaveBeenCalledWith('test-agent', {
      limit: 100,
      staleTime: 30_000,
    })
  })

  it('uses one card-health batch without fetching graph topology or per-agent activity', async () => {
    vi.useRealTimers()
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())
    const urls = mockApiFetch.mock.calls.map(([url]) => url)
    expect(urls).toEqual([
      `/api/home-card-health?days=14&tz=${new Date().getTimezoneOffset()}`,
    ])
    expect(urls).not.toContain('/api/home-graph')
    expect(urls.some((url) => String(url).startsWith('/api/activity/agents/'))).toBe(false)
  })

  it('renders cron activity from the shared card-health payload', async () => {
    vi.useRealTimers()
    mockHomeCardHealthData.mockReturnValue({
      days: 14,
      generatedAt: '2026-03-26T12:00:00.000Z',
      crons: [{
        id: 'cron-a',
        agentSlug: 'test-agent',
        name: 'Daily report',
        scheduleExpression: '0 9 * * *',
      }],
      webhooks: [],
      cronByTaskId: {
        'cron-a': [{
          scheduledAt: '2026-03-26T09:00:00.000Z',
          status: 'succeeded',
        }],
      },
      webhookByTriggerId: {},
    })
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    expect(await screen.findByRole('img', {
      name: 'Daily report: 1 planned run, 1 ran, 0 skipped, and 0 failed.',
    })).toBeInTheDocument()
  })

  it('opens the unified card menu from the focused link without a visible kebab', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    expect(screen.queryByRole('button', { name: 'Options for Test Agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Expanded' })).toBeInTheDocument()
    expect(document.querySelector('button button')).toBeNull()
    const contextMenuEvent = vi.fn()
    screen.getByTestId('agent-context-trigger').addEventListener('contextmenu', contextMenuEvent)
    fireEvent.keyDown(screen.getByRole('link', { name: 'Open Test Agent' }), {
      key: 'F10',
      shiftKey: true,
    })
    expect(contextMenuEvent).toHaveBeenCalledTimes(1)
    const widget = document.querySelector('[data-widget-id="test-agent"]')
    expect(widget).toHaveClass('touch-pan-y')
    expect(widget).not.toHaveClass('touch-none')
  })

  it('preserves hidden dashboard geometry when another card is resized', () => {
    const dashboardRect = { x: 2, y: 3, w: 1, h: 1 }
    mockUserSettingsData.mockReturnValue({
      hiddenAppCards: ['test-agent'],
      homeGridLayout: {
        'test-agent': { x: 0, y: 0, w: 2, h: 1 },
        'dash::test-agent::sales': dashboardRect,
      },
    })
    mockAgentsData.mockReturnValue({
      data: [
        makeAgent({
          dashboards: [{ slug: 'sales', name: 'Sales' }],
        }),
      ],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)

    screen.getByRole('switch', { name: 'Expanded' }).click()

    const layoutCall = mockUpdateSettingsMutate.mock.calls.find(
      ([data]) => data && typeof data === 'object' && 'homeGridLayout' in data
    )
    expect(layoutCall?.[0].homeGridLayout['dash::test-agent::sales']).toEqual(dashboardRect)
  })

  it('preserves missing dashboard geometry while its owning agent still exists', () => {
    const dashboardRect = { x: 2, y: 3, w: 1, h: 1 }
    mockUserSettingsData.mockReturnValue({
      hiddenAppCards: [],
      homeGridLayout: {
        'test-agent': { x: 0, y: 0, w: 2, h: 1 },
        'dash::test-agent::sales': dashboardRect,
      },
    })
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboards: [] })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)

    screen.getByRole('switch', { name: 'Expanded' }).click()

    const layoutCall = mockUpdateSettingsMutate.mock.calls.find(
      ([data]) => data && typeof data === 'object' && 'homeGridLayout' in data
    )
    expect(layoutCall?.[0].homeGridLayout['dash::test-agent::sales']).toEqual(dashboardRect)
  })

  it('rolls back an optimistic layout change when persistence fails', () => {
    mockUserSettingsData.mockReturnValue({
      homeGridLayout: {
        'test-agent': { x: 0, y: 0, w: 2, h: 1 },
      },
    })
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    mockUpdateSettingsMutate.mockImplementationOnce((_data, options) => {
      options?.onError?.(new Error('offline'))
      options?.onSettled?.()
    })
    renderWithProviders(<HomePage />)

    screen.getByRole('switch', { name: 'Expanded' }).click()

    expect(screen.getByRole('switch', { name: 'Expanded' })).toHaveAttribute('aria-checked', 'true')
    expect(mockToastError).toHaveBeenCalledWith('Failed to save the home layout', {
      description: 'offline',
    })
  })

  it('rolls back an optimistic app-card toggle when persistence fails', () => {
    mockUserSettingsData.mockReturnValue({ hiddenAppCards: [] })
    mockAgentsData.mockReturnValue({
      data: [
        makeAgent({
          dashboards: [{ slug: 'sales', name: 'Sales' }],
        }),
      ],
      isLoading: false,
    })
    mockUpdateSettingsMutate.mockImplementationOnce((_data, options) => {
      options?.onError?.(new Error('offline'))
      options?.onSettled?.()
    })
    renderWithProviders(<HomePage />)

    screen.getByRole('switch', { name: 'Show app' }).click()

    expect(screen.getByText('Open app')).toBeInTheDocument()
    expect(mockToastError).toHaveBeenCalledWith('Failed to update app-card visibility', {
      description: 'offline',
    })
  })

  it('replaces New Agent with Cancel and Done while arranging', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    expect(screen.getByRole('button', { name: 'New Agent' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('home-arrange-action'))

    expect(screen.queryByRole('button', { name: 'New Agent' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    expect(document.querySelector('[data-widget-id="test-agent"]')).toHaveAttribute('data-arranging', 'true')
    expect(screen.getByTestId('agent-context-trigger')).not.toHaveAttribute('data-touch-long-press-disabled')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'New Agent' })).toBeInTheDocument()
  })

  it('can enter arrange mode from an agent context menu', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    fireEvent.click(screen.getByTestId('agent-menu-arrange'))

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(document.querySelector('[data-widget-id="test-agent"]')).toHaveAttribute('data-arranging', 'true')
  })

  it('stages arrange-mode drags until Done persists them', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)
    fireEvent.click(screen.getByTestId('home-arrange-action'))

    const widget = document.querySelector('[data-widget-id="test-agent"]')
    expect(widget).not.toBeNull()
    fireEvent.pointerDown(widget!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 80 })
    fireEvent.pointerUp(window)

    expect(mockUpdateSettingsMutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(mockUpdateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ homeGridLayout: expect.any(Object) }),
      expect.any(Object),
    )
  })

  it('stages app-card visibility until Done and restores it on Cancel', () => {
    mockUserSettingsData.mockReturnValue({ hiddenAppCards: [] })
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboards: [{ slug: 'sales', name: 'Sales' }] })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)

    fireEvent.click(screen.getByTestId('home-arrange-action'))
    fireEvent.click(screen.getByRole('switch', { name: 'Show app' }))
    expect(screen.queryByText('Open app')).not.toBeInTheDocument()
    expect(mockUpdateSettingsMutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Open app')).toBeInTheDocument()
    expect(mockUpdateSettingsMutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('home-arrange-action'))
    fireEvent.click(screen.getByRole('switch', { name: 'Show app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(mockUpdateSettingsMutate).toHaveBeenCalledWith(
      { hiddenAppCards: ['test-agent'] },
      expect.any(Object)
    )
  })

  it('cancels Arrange when the mobile breakpoint changes', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    const { rerender } = renderWithProviders(<HomePage />)
    fireEvent.click(screen.getByTestId('home-arrange-action'))
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()

    mockUseIsMobile.mockReturnValue(true)
    rerender(<HomePage />)

    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New Agent' })).toBeInTheDocument()
    expect(mockUpdateSettingsMutate).not.toHaveBeenCalled()
  })

  it('disables mobile dragging until explicit arrange mode', () => {
    mockUseIsMobile.mockReturnValue(true)
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    const widget = document.querySelector('[data-widget-id="test-agent"]')
    fireEvent.pointerDown(widget!, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 40, clientY: 80 })
    fireEvent.pointerUp(window)
    expect(mockUpdateSettingsMutate).not.toHaveBeenCalled()
    expect(widget).toHaveClass('touch-pan-y')

    fireEvent.click(screen.getByTestId('home-arrange-action'))
    expect(document.querySelector('[data-widget-id="test-agent"]')).toHaveClass('touch-none')
    expect(screen.getByTestId('agent-context-trigger')).toHaveAttribute('data-touch-long-press-disabled', 'true')
  })

  it('forks mobile changes without overwriting the saved desktop layout', () => {
    const desktopRect = { x: 4, y: 2, w: 2, h: 1 }
    const settings = {
      homeGridLayout: {
        'test-agent': desktopRect,
      },
    }
    mockUseIsMobile.mockReturnValue(true)
    mockUserSettingsData.mockReturnValue(settings)
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    // With no mobile map yet, the phone inherits the desktop card size.
    const expanded = screen.getByRole('switch', { name: 'Expanded' })
    expect(expanded).toHaveAttribute('aria-checked', 'true')
    expanded.click()

    expect(mockUpdateSettingsMutate).toHaveBeenCalledWith(
      {
        homeGridMobileLayout: {
          'test-agent': expect.objectContaining({ w: 1, h: 1 }),
        },
      },
      expect.any(Object)
    )
    const payload = mockUpdateSettingsMutate.mock.calls[0][0]
    expect(payload).not.toHaveProperty('homeGridLayout')
    expect(settings.homeGridLayout['test-agent']).toEqual(desktopRect)
  })
})

describe('HomePage view toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRouteSearch.mockReturnValue({})
  })

  it('defaults to cards and navigates to ?view=graph on toggle', async () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    // Cards view renders the agent grid; both toggle buttons are present.
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
    expect(screen.getByTestId('home-view-cards')).toHaveAttribute('aria-pressed', 'true')

    screen.getByTestId('home-view-graph').click()
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/', search: expect.any(Function) }),
    )
    // The search updater writes view=graph and preserves other params.
    const updater = mockNavigate.mock.calls[0][0].search as (p: Record<string, unknown>) => Record<string, unknown>
    expect(updater({ redirect: '/x' })).toEqual({ redirect: '/x', view: 'graph' })
  })

  it('renders the graph empty state for ?view=graph with no agents', () => {
    mockRouteSearch.mockReturnValue({ view: 'graph' })
    mockAgentsData.mockReturnValue({ data: [], isLoading: false })
    renderWithProviders(<HomePage />)

    expect(screen.getByTestId('graph-empty-state')).toBeInTheDocument()
    expect(screen.getByTestId('home-view-graph')).toHaveAttribute('aria-pressed', 'true')
  })
})
