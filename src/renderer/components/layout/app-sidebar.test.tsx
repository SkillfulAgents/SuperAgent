// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppSidebar } from './app-sidebar'
import { renderWithProviders } from '@renderer/test/test-utils'

// Define __APP_VERSION__ global
vi.stubGlobal('__APP_VERSION__', '0.1.0-test')

// Mock env
vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getPlatform: () => 'web',
}))

// Mock hooks
const mockUseAgents = vi.fn(() => ({
  data: [
    {
      slug: 'test-agent',
      name: 'Test Agent',
      status: 'running',
      containerPort: 3000,
      createdAt: new Date(),
      hasActiveSessions: false,
      hasSessionsAwaitingInput: false,
      sessionCount: 1,
      scheduledTaskCount: 0,
      dashboardCount: 0,
    },
    {
      slug: 'other-agent',
      name: 'Other Agent',
      status: 'stopped',
      containerPort: null,
      createdAt: new Date(),
      hasActiveSessions: false,
      hasSessionsAwaitingInput: false,
      sessionCount: 0,
      scheduledTaskCount: 0,
      dashboardCount: 0,
    },
  ],
  isLoading: false,
  error: null,
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => mockUseAgents(),
}))

const mockUseSessions = vi.fn((_slug: string): { data: any[] | undefined } => ({
  data: _slug === 'test-agent'
    ? [
        {
          id: 'session-1',
          agentSlug: 'test-agent',
          name: 'Session 1',
          messageCount: 5,
          lastActivityAt: new Date(),
          createdAt: new Date(),
          isActive: false,
        },
      ]
    : [],
}))
vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: (slug: string) => mockUseSessions(slug),
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({
    isActive: false,
    isStreaming: false,
    streamingMessage: null,
    streamingToolUse: null,
    pendingSecretRequests: [],
    pendingConnectedAccountRequests: [],
    pendingQuestionRequests: [],
    pendingFileRequests: [],
    pendingRemoteMcpRequests: [],
    error: null,
    browserActive: false,
    activeStartTime: null,
    isCompacting: false,
    contextUsage: null,
    activeSubagent: null,
    slashCommands: [],
  }),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      runtimeReadiness: { status: 'READY' },
      setupCompleted: true,
      apiKeyStatus: { anthropic: { isConfigured: true } },
    },
  }),
}))

const mockUseScheduledTasks = vi.fn((_slug?: string, _status?: string): { data: any[] } => ({ data: [] }))
vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: (slug: string, status?: string) => mockUseScheduledTasks(slug, status),
}))

vi.mock('@renderer/hooks/use-artifacts', () => ({
  useArtifacts: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

// Mock dialog context
const mockDialogContext = {
  settingsOpen: false,
  setSettingsOpen: vi.fn(),
  settingsTab: undefined,
  createAgentOpen: false,
  createAgentTemplate: null,
  openCreateAgent: vi.fn(),
  closeCreateAgent: vi.fn(),
  openWizard: vi.fn(),
}
vi.mock('@renderer/context/dialog-context', () => ({
  useDialogs: () => mockDialogContext,
  DialogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock selection context
const mockSelectionContext = {
  selectedAgentSlug: null as string | null,
  selectedSessionId: null as string | null,
  selectedScheduledTaskId: null as string | null,
  selectedDashboardSlug: null as string | null,
  selectAgent: vi.fn(),
  selectSession: vi.fn(),
  selectScheduledTask: vi.fn(),
  selectDashboard: vi.fn(),
  clearSelection: vi.fn(),
}
vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => mockSelectionContext,
}))

// Mock complex child components
vi.mock('@renderer/components/agents/create-agent-screen', () => ({
  CreateAgentScreen: () => null,
}))

vi.mock('@renderer/components/agents/agent-status', () => ({
  AgentStatus: ({ status, hasSessionsAwaitingInput }: { status: string; hasSessionsAwaitingInput?: boolean }) => (
    <span data-testid={`agent-status-${status}`} data-awaiting={hasSessionsAwaitingInput ? 'true' : 'false'}>{status}</span>
  ),
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/sessions/session-context-menu', () => ({
  SessionContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/settings/global-settings-dialog', () => ({
  GlobalSettingsDialog: () => null,
}))

vi.mock('@renderer/components/settings/container-setup-dialog', () => ({
  ContainerSetupDialog: () => null,
}))

vi.mock('@renderer/components/notifications/notification-bell', () => ({
  NotificationBell: () => <button data-testid="notification-bell">Notifications</button>,
}))

// Mock ErrorBoundary
vi.mock('@renderer/components/ui/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock Sidebar UI components
vi.mock('@renderer/components/ui/sidebar', () => ({
  Sidebar: ({ children, ...props }: any) => <aside {...props}>{children}</aside>,
  SidebarContent: ({ children }: any) => <div>{children}</div>,
  SidebarFooter: ({ children }: any) => <div>{children}</div>,
  SidebarHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupAction: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: any) => <span>{children}</span>,
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuAction: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  SidebarMenuButton: ({ children, onClick, ...props }: any) => <button onClick={onClick} {...props}>{children}</button>,
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuSkeleton: () => <div data-testid="skeleton" />,
  SidebarMenuSub: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuSubButton: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarMenuSubItem: ({ children }: any) => <li>{children}</li>,
  SidebarRail: () => null,
}))

// Mock Collapsible
vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({ children, open }: any) => <div data-open={open}>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
}))

// Mock Alert
vi.mock('@renderer/components/ui/alert', () => ({
  Alert: ({ children, ...props }: any) => <div role="alert" {...props}>{children}</div>,
  AlertDescription: ({ children }: any) => <span>{children}</span>,
}))

// Factory for creating mock scheduled tasks
function createMockScheduledTask(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'task-1',
    agentSlug: overrides.agentSlug ?? 'test-agent',
    scheduleType: overrides.scheduleType ?? 'cron',
    scheduleExpression: overrides.scheduleExpression ?? '*/15 * * * *',
    prompt: overrides.prompt ?? 'Do something',
    name: overrides.name ?? 'Test Task',
    status: overrides.status ?? 'pending',
    nextExecutionAt: overrides.nextExecutionAt ?? new Date('2025-01-01T12:00:00Z'),
    lastExecutedAt: overrides.lastExecutedAt ?? null,
    isRecurring: overrides.isRecurring ?? true,
    executionCount: overrides.executionCount ?? 0,
    lastSessionId: overrides.lastSessionId ?? null,
    createdBySessionId: overrides.createdBySessionId ?? null,
    timezone: overrides.timezone ?? null,
    createdAt: overrides.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    cancelledAt: overrides.cancelledAt ?? null,
  }
}

// Helper to configure scheduled tasks mock for a specific agent
function setScheduledTasksMock(
  agentSlug: string,
  pending: ReturnType<typeof createMockScheduledTask>[],
  cancelled: ReturnType<typeof createMockScheduledTask>[] = [],
) {
  mockUseScheduledTasks.mockImplementation((slug?: string, status?: string): { data: any[] } => {
    if (slug !== agentSlug) return { data: [] }
    if (status === 'pending') return { data: pending }
    if (status === 'cancelled') return { data: cancelled }
    return { data: [] }
  })
}

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSelectionContext.selectedAgentSlug = null
    mockSelectionContext.selectedSessionId = null
    // Reset mocks that individual tests may override
    mockUseScheduledTasks.mockImplementation(() => ({ data: [] }))
    mockUseSessions.mockImplementation((slug: string) => ({
      data: slug === 'test-agent'
        ? [
            {
              id: 'session-1',
              agentSlug: 'test-agent',
              name: 'Session 1',
              messageCount: 5,
              lastActivityAt: new Date(),
              createdAt: new Date(),
              isActive: false,
            },
          ]
        : [],
    }))
  })

  it('renders "Super Agent" title', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Super Agent')).toBeInTheDocument()
  })

  it('renders agent list', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
    expect(screen.getByText('Other Agent')).toBeInTheDocument()
  })

  it('renders agent status', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('agent-status-running')).toBeInTheDocument()
    expect(screen.getByTestId('agent-status-stopped')).toBeInTheDocument()
  })

  it('renders "Agents" group label', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('renders Settings button', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders version number', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Version: 0.1.0-test')).toBeInTheDocument()
  })

  it('renders create agent button', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('create-agent-button')).toBeInTheDocument()
  })

  it('opens create agent screen on button click', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)

    await user.click(screen.getByTestId('create-agent-button'))
    expect(mockDialogContext.openCreateAgent).toHaveBeenCalled()
  })

  it('renders session sub-items', () => {
    // Agent must be selected for collapsible to open and lazy-load sessions
    mockSelectionContext.selectedAgentSlug = 'test-agent'
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Session 1')).toBeInTheDocument()
  })

  it('selects agent and session on session click', async () => {
    mockSelectionContext.selectedAgentSlug = 'test-agent'
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)

    await user.click(screen.getByTestId('session-item-session-1'))
    expect(mockSelectionContext.selectAgent).toHaveBeenCalledWith('test-agent')
    expect(mockSelectionContext.selectSession).toHaveBeenCalledWith('session-1')
  })

  it('shows notification bell', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument()
  })

  // ==========================================================================
  // Awaiting Input Status Tests
  // ==========================================================================

  it('derives awaiting input status from sessions data when available', () => {
    // Agent data says not awaiting (stale), but sessions data says awaiting (fresh)
    mockUseAgents.mockReturnValue({
      data: [
        {
          slug: 'test-agent',
          name: 'Test Agent',
          status: 'running',
          containerPort: 3000,
          createdAt: new Date(),
          hasActiveSessions: true,
          hasSessionsAwaitingInput: false, // stale agent-level data
          sessionCount: 1,
          scheduledTaskCount: 0,
          dashboardCount: 0,
        },
      ],
      isLoading: false,
      error: null,
    })
    mockUseSessions.mockReturnValue({
      data: [
        {
          id: 'session-1',
          agentSlug: 'test-agent',
          name: 'Session 1',
          messageCount: 5,
          lastActivityAt: new Date(),
          createdAt: new Date(),
          isActive: true,
          isAwaitingInput: true, // fresh sessions data shows awaiting
        },
      ],
    })
    mockSelectionContext.selectedAgentSlug = 'test-agent'

    renderWithProviders(<AppSidebar />)

    const statusEl = screen.getByTestId('agent-status-running')
    expect(statusEl).toHaveAttribute('data-awaiting', 'true')
  })

  it('falls back to agent data when sessions are not loaded', () => {
    mockUseAgents.mockReturnValue({
      data: [
        {
          slug: 'test-agent',
          name: 'Test Agent',
          status: 'running',
          containerPort: 3000,
          createdAt: new Date(),
          hasActiveSessions: true,
          hasSessionsAwaitingInput: true, // agent-level data says awaiting
          sessionCount: 1,
          scheduledTaskCount: 0,
          dashboardCount: 0,
        },
      ],
      isLoading: false,
      error: null,
    })
    // Sessions not loaded (agent not expanded)
    mockUseSessions.mockReturnValue({ data: undefined })

    renderWithProviders(<AppSidebar />)

    const statusEl = screen.getByTestId('agent-status-running')
    expect(statusEl).toHaveAttribute('data-awaiting', 'true')
  })

  // ==========================================================================
  // Scheduled Tasks Display Tests
  // ==========================================================================

  describe('scheduled tasks display', () => {
    // Helper: set agent as selected (opens collapsible) and set scheduledTaskCount
    // so the chevron shows and lazy hooks fire
    function selectAgentWithTaskCount(taskCount: number) {
      mockSelectionContext.selectedAgentSlug = 'test-agent'
      mockUseAgents.mockReturnValue({
        data: [
          {
            slug: 'test-agent',
            name: 'Test Agent',
            status: 'running',
            containerPort: 3000,
            createdAt: new Date(),
            hasActiveSessions: false,
            hasSessionsAwaitingInput: false,
            sessionCount: 1,
            scheduledTaskCount: taskCount,
            dashboardCount: 0,
          },
          {
            slug: 'other-agent',
            name: 'Other Agent',
            status: 'stopped',
            containerPort: null,
            createdAt: new Date(),
            hasActiveSessions: false,
            hasSessionsAwaitingInput: false,
            sessionCount: 0,
            scheduledTaskCount: 0,
            dashboardCount: 0,
          },
        ],
        isLoading: false,
        error: null,
      })
    }

    it('does not show scheduled section when no tasks exist', () => {
      mockSelectionContext.selectedAgentSlug = 'test-agent'
      renderWithProviders(<AppSidebar />)
      expect(screen.queryByText(/Scheduled Jobs/)).not.toBeInTheDocument()
    })

    it('shows a single pending task flat (no group) when only 1 pending and 0 cancelled', () => {
      selectAgentWithTaskCount(1)
      setScheduledTasksMock('test-agent', [
        createMockScheduledTask({ name: 'Daily Check' }),
      ])

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Daily Check')).toBeInTheDocument()
      expect(screen.queryByText(/Scheduled Jobs/)).not.toBeInTheDocument()
    })

    it('shows "Scheduled Jobs (N)" group when there are 2+ pending tasks', () => {
      selectAgentWithTaskCount(2)
      setScheduledTasksMock('test-agent', [
        createMockScheduledTask({ id: 'task-1', name: 'Task A' }),
        createMockScheduledTask({ id: 'task-2', name: 'Task B' }),
      ])

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Scheduled Jobs (2)')).toBeInTheDocument()
      expect(screen.getByText('Task A')).toBeInTheDocument()
      expect(screen.getByText('Task B')).toBeInTheDocument()
    })

    it('shows "Scheduled Jobs (N)" group when there are cancelled tasks, even with only 1 pending', () => {
      selectAgentWithTaskCount(1)
      setScheduledTasksMock('test-agent',
        [createMockScheduledTask({ id: 'task-1', name: 'Active Job' })],
        [createMockScheduledTask({ id: 'task-2', name: 'Old Job', status: 'cancelled' })],
      )

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Scheduled Jobs (2)')).toBeInTheDocument()
      expect(screen.getByText('Active Job')).toBeInTheDocument()
    })

    it('shows "Scheduled Jobs (1)" group with "Cancelled" when 0 pending and 1 cancelled', () => {
      selectAgentWithTaskCount(0)
      setScheduledTasksMock('test-agent', [], [
        createMockScheduledTask({ id: 'task-1', name: 'Cancelled Cron', status: 'cancelled' }),
      ])

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Scheduled Jobs (1)')).toBeInTheDocument()
      expect(screen.getByText('Cancelled (1)')).toBeInTheDocument()
    })

    it('shows "Cancelled (N)" section inside the group with correct count', () => {
      selectAgentWithTaskCount(1)
      setScheduledTasksMock('test-agent',
        [createMockScheduledTask({ id: 'task-1', name: 'Active' })],
        [
          createMockScheduledTask({ id: 'task-2', name: 'Cancelled A', status: 'cancelled' }),
          createMockScheduledTask({ id: 'task-3', name: 'Cancelled B', status: 'cancelled' }),
        ],
      )

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Scheduled Jobs (3)')).toBeInTheDocument()
      expect(screen.getByText('Cancelled (2)')).toBeInTheDocument()
      expect(screen.getByText('Cancelled A')).toBeInTheDocument()
      expect(screen.getByText('Cancelled B')).toBeInTheDocument()
    })

    it('does not show "Cancelled" section when there are no cancelled tasks', () => {
      selectAgentWithTaskCount(2)
      setScheduledTasksMock('test-agent', [
        createMockScheduledTask({ id: 'task-1', name: 'Task A' }),
        createMockScheduledTask({ id: 'task-2', name: 'Task B' }),
      ])

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Scheduled Jobs (2)')).toBeInTheDocument()
      expect(screen.queryByText(/Cancelled/)).not.toBeInTheDocument()
    })

    it('counts total (pending + cancelled) in "Scheduled Jobs" header', () => {
      selectAgentWithTaskCount(2)
      setScheduledTasksMock('test-agent',
        [
          createMockScheduledTask({ id: 'task-1', name: 'P1' }),
          createMockScheduledTask({ id: 'task-2', name: 'P2' }),
        ],
        [createMockScheduledTask({ id: 'task-3', name: 'C1', status: 'cancelled' })],
      )

      renderWithProviders(<AppSidebar />)
      expect(screen.getByText('Scheduled Jobs (3)')).toBeInTheDocument()
    })

    it('selects scheduled task on click', async () => {
      selectAgentWithTaskCount(1)
      const user = userEvent.setup()
      setScheduledTasksMock('test-agent', [
        createMockScheduledTask({ id: 'task-42', name: 'Clickable Task' }),
      ])

      renderWithProviders(<AppSidebar />)
      await user.click(screen.getByText('Clickable Task'))
      expect(mockSelectionContext.selectAgent).toHaveBeenCalledWith('test-agent')
      expect(mockSelectionContext.selectScheduledTask).toHaveBeenCalledWith('task-42')
    })

    it('calls useScheduledTasks with both pending and cancelled status when expanded', () => {
      mockSelectionContext.selectedAgentSlug = 'test-agent'
      renderWithProviders(<AppSidebar />)
      expect(mockUseScheduledTasks).toHaveBeenCalledWith('test-agent', 'pending')
      expect(mockUseScheduledTasks).toHaveBeenCalledWith('test-agent', 'cancelled')
    })
  })
})
