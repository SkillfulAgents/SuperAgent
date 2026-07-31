// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'

// ============================================================================
// AgentCard component tests (rendered via HomePage)
// ============================================================================

// Mock all dependencies for HomePage rendering

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
  useSessions: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-activity-stats', () => ({
  useAgentActivityStats: () => ({ data: undefined, isPending: true }),
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
  useUserSettings: () => ({ data: null }),
  useUpdateUserSettings: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@renderer/lib/agent-ordering', () => ({
  applyAgentOrder: (agents: unknown[]) => agents,
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getPlatform: () => 'web',
  getApiBaseUrl: () => '',
}))

// Import after mocks
import { HomePage } from './home-page'

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
    // status='running' + hasSessionsAwaitingInput → getAgentActivityStatus aggregates
    // to 'awaiting_input', surfaced as the dot-matrix indicator's aria-label.
    expect(screen.getByRole('img', { name: 'awaiting_input' })).toBeInTheDocument()
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
