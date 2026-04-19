// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import { formatRelativeTime } from './home-page'

// ============================================================================
// formatRelativeTime unit tests
// ============================================================================

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T12:00:00Z'))
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('returns null for null/undefined input', () => {
    expect(formatRelativeTime(null)).toBeNull()
    expect(formatRelativeTime(undefined)).toBeNull()
  })

  it('returns "just now" for times less than 1 minute ago', () => {
    const thirtySecsAgo = new Date('2026-03-26T11:59:31Z')
    expect(formatRelativeTime(thirtySecsAgo)).toBe('just now')
  })

  it('returns "just now" for times less than 1 minute in the future', () => {
    const thirtySecsFromNow = new Date('2026-03-26T12:00:29Z')
    expect(formatRelativeTime(thirtySecsFromNow)).toBe('just now')
  })

  it('returns minutes ago for past times < 1 hour', () => {
    const fiveMinsAgo = new Date('2026-03-26T11:55:00Z')
    expect(formatRelativeTime(fiveMinsAgo)).toBe('5m ago')
  })

  it('returns "in Xm" for future times < 1 hour', () => {
    const tenMinsFromNow = new Date('2026-03-26T12:10:00Z')
    expect(formatRelativeTime(tenMinsFromNow)).toBe('in 10m')
  })

  it('returns hours ago for past times < 24 hours', () => {
    const threeHoursAgo = new Date('2026-03-26T09:00:00Z')
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago')
  })

  it('returns "in Xh" for future times < 24 hours', () => {
    const twoHoursFromNow = new Date('2026-03-26T14:00:00Z')
    expect(formatRelativeTime(twoHoursFromNow)).toBe('in 2h')
  })

  it('returns days ago for past times < 30 days', () => {
    const fiveDaysAgo = new Date('2026-03-21T12:00:00Z')
    expect(formatRelativeTime(fiveDaysAgo)).toBe('5d ago')
  })

  it('returns "in Xd" for future times < 30 days', () => {
    const threeDaysFromNow = new Date('2026-03-29T12:00:00Z')
    expect(formatRelativeTime(threeDaysFromNow)).toBe('in 3d')
  })

  it('returns months ago for past times >= 30 days', () => {
    // 59 days ago → floor(59/30) = 1mo
    const aboutOneMonthAgo = new Date('2026-01-26T12:00:00Z')
    expect(formatRelativeTime(aboutOneMonthAgo)).toBe('1mo ago')

    // 90 days ago → floor(90/30) = 3mo
    const threeMonthsAgo = new Date('2025-12-26T12:00:00Z')
    expect(formatRelativeTime(threeMonthsAgo)).toBe('3mo ago')
  })

  it('returns "in Xmo" for future times >= 30 days', () => {
    const sixtyDaysFromNow = new Date('2026-05-25T12:00:00Z')
    expect(formatRelativeTime(sixtyDaysFromNow)).toBe('in 2mo')
  })

  it('accepts string dates', () => {
    expect(formatRelativeTime('2026-03-26T11:55:00Z')).toBe('5m ago')
  })

  it('accepts Date objects', () => {
    expect(formatRelativeTime(new Date('2026-03-26T11:55:00Z'))).toBe('5m ago')
  })
})

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

const mockSelectAgent = vi.fn()
const mockSelectSession = vi.fn()
const mockSelectDashboard = vi.fn()
vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => ({ selectAgent: mockSelectAgent, selectSession: mockSelectSession, selectDashboard: mockSelectDashboard, selectedAgent: null }),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: () => ({ data: [] }),
}))

const mockAgentsData = vi.fn()
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => mockAgentsData(),
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: null }),
}))

vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-usage', () => ({
  useUsageData: () => ({ data: undefined, refetch: vi.fn() }),
}))

vi.mock('@renderer/lib/agent-ordering', () => ({
  applyAgentOrder: (agents: unknown[]) => agents,
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@renderer/components/agents/agent-status', () => ({
  AgentStatus: ({ status }: { status: string }) => <span data-testid="agent-status">{status}</span>,
  getAgentActivityStatus: () => 'sleeping',
}))

vi.mock('@renderer/hooks/use-create-untitled-agent', () => ({
  useCreateUntitledAgent: () => ({
    createUntitledAgent: vi.fn(),
    isPending: false,
  }),
  UNTITLED_AGENT_NAME: 'Untitled',
}))

vi.mock('@renderer/components/agents/template-install-dialog', () => ({
  TemplateInstallDialog: () => null,
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
}))

// Import after mocks
import { HomePage } from './home-page'

function makeAgent(overrides = {}) {
  return {
    slug: 'test-agent',
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

  it('renders agent name and description', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent()],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
    expect(screen.getByText('A test description')).toBeInTheDocument()
  })

  it('renders last worked time when lastActivityAt is set', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ lastActivityAt: new Date('2026-03-26T09:00:00Z') })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('3h ago')).toBeInTheDocument()
  })

  it('does not render last worked when lastActivityAt is null', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ lastActivityAt: null })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it('renders scheduled task count with singular form', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ scheduledTaskCount: 1, nextScheduledTaskAt: new Date('2026-03-26T14:00:00Z') })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('1 task')).toBeInTheDocument()
    expect(screen.getByText(/in 2h/)).toBeInTheDocument()
  })

  it('renders scheduled task count with plural form', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ scheduledTaskCount: 3, nextScheduledTaskAt: new Date('2026-03-27T12:00:00Z') })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('3 tasks')).toBeInTheDocument()
  })

  it('does not render scheduled tasks when count is 0', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ scheduledTaskCount: 0 })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.queryByText(/task/)).not.toBeInTheDocument()
  })

  it('renders dashboard chips for 1-2 dashboards', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboardCount: 2, dashboardNames: ['Sales', 'Metrics'] })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(screen.getByText('Metrics')).toBeInTheDocument()
  })

  it('renders "N dashboards" dropdown trigger for 3+ dashboards', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboardCount: 4, dashboardNames: ['A', 'B', 'C', 'D'] })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('4 dashboards')).toBeInTheDocument()
    // Popover content should list all names
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('D')).toBeInTheDocument()
  })

  it('does not render dashboards section when count is 0', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ dashboardCount: 0, dashboardNames: [] })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.queryByText(/dashboard/i)).not.toBeInTheDocument()
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
      })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    expect(screen.getByText('1h ago')).toBeInTheDocument()
    expect(screen.getByText('2 tasks')).toBeInTheDocument()
    expect(screen.getByText(/in 1h/)).toBeInTheDocument()
    expect(screen.getByText('Overview')).toBeInTheDocument()
  })

  it('passes pre-aggregated status to AgentStatus', () => {
    mockAgentsData.mockReturnValue({
      data: [makeAgent({ hasActiveSessions: true, hasSessionsAwaitingInput: true })],
      isLoading: false,
    })
    renderWithProviders(<HomePage />)
    // The mocked AgentStatus just renders the status prop
    expect(screen.getByTestId('agent-status')).toBeInTheDocument()
  })
})
