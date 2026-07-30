// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'

// ============================================================================
// AgentCard component tests (rendered via HomePage)
// ============================================================================

// Mock all dependencies for HomePage rendering

const {
  mockUseNotableSessions,
  mockUseAgentActivityStats,
  mockUserSettingsData,
  mockUpdateSettingsMutate,
  mockToastError,
  mockUseIsMobile,
} = vi.hoisted(() => ({
  mockUseNotableSessions: vi.fn<() => { data: Array<Record<string, unknown>> }>(() => ({ data: [] })),
  mockUseAgentActivityStats: vi.fn(() => ({ data: undefined, isPending: true })),
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

vi.mock('@renderer/hooks/use-activity-stats', () => ({
  useAgentActivityStats: mockUseAgentActivityStats,
}))

// The home page fetches the /api/home-graph topology snapshot for the cards'
// health carousels; return an empty topology so no carousel renders.
vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      accountLinks: [],
      mcpLinks: [],
      chats: [],
      webhooks: [],
      crons: [],
      permissions: [],
      invocations: [],
      accountUsage: {},
      mcpUsage: {},
    }),
  })),
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
      {additionalOptions}
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
    scheduledTaskCount: 0,
    nextScheduledTaskAt: null as Date | null,
    dashboardCount: 0,
    dashboardNames: [] as string[],
    dashboards: [] as Array<{ slug: string; name: string; hasScreenshot?: boolean }>,
    ...overrides,
  }
}

describe('HomePage AgentCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T12:00:00Z'))
    vi.clearAllMocks()
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

  it('does not render scheduled task details (removed from the compact card)', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ scheduledTaskCount: 3, nextScheduledTaskAt: new Date('2026-03-27T12:00:00Z') })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.queryByText('3 tasks')).not.toBeInTheDocument()
  })

  it('renders a dashboard card per dashboard alongside the agent card', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        dashboardCount: 2,
        dashboardNames: ['Sales', 'Metrics'],
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
  })

  it('renders a screenshot img when hasScreenshot is true', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        dashboardCount: 1,
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
        dashboardCount: 1,
        dashboards: [{ slug: 'sales', name: 'Sales' }],
      })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    const img = document.querySelector('img[src*="/screenshot.png"]')
    expect(img).toBeNull()
  })

  it('renders no dashboard cards when count is 0', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboardCount: 0, dashboards: [] })],
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
    expect(screen.getByText('No agents yet')).toBeInTheDocument()
  })

  it('renders all summary fields together', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({
        lastActivityAt: new Date('2026-03-26T11:00:00Z'),
        scheduledTaskCount: 2,
        nextScheduledTaskAt: new Date('2026-03-26T13:00:00Z'),
        dashboardCount: 1,
        dashboardNames: ['Overview'],
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

  it('does not request activity statistics for agents without health slides', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    expect(mockUseAgentActivityStats).toHaveBeenCalledWith(null, 14, { live: false })
  })

  it('moves card options into the context menu and avoids nested native buttons', () => {
    mockAgentsData.mockReturnValue({ data: [makeAgent()], isLoading: false })
    renderWithProviders(<HomePage />)

    expect(screen.queryByRole('button', { name: 'Card options' })).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Expanded' })).toBeInTheDocument()
    expect(document.querySelector('button button')).toBeNull()
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
          dashboardCount: 1,
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
      data: [makeAgent({ dashboardCount: 0, dashboards: [] })],
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
          dashboardCount: 1,
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
