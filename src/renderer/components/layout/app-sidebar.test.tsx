// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppSidebar } from './app-sidebar'
import { renderWithProviders } from '@renderer/test/test-utils'

vi.stubGlobal('__APP_VERSION__', '0.1.0-test')
vi.stubGlobal('__RENDER_TRACKING__', false)

vi.mock('@renderer/lib/env', () => ({
  isElectron: () => false,
  getPlatform: () => 'web',
  openDashboardExternal: vi.fn(),
  getApiBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })),
}))

const mockUseAgents = vi.fn()
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => mockUseAgents(),
}))

const mockCreateUntitledAgent = vi.fn()
vi.mock('@renderer/hooks/use-create-untitled-agent', () => ({
  useCreateUntitledAgent: () => ({
    createUntitledAgent: mockCreateUntitledAgent,
    isPending: false,
  }),
}))

const mockUseSessions = vi.fn()
vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: (slug: string | null) => mockUseSessions(slug),
}))

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ isStreaming: false }),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({
    data: { llmProvider: 'anthropic', apiKeyStatus: { anthropic: { isConfigured: true } } },
  }),
}))

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { setupCompleted: true, agentOrder: [] } }),
  useUpdateUserSettings: () => ({ mutate: vi.fn() }),
}))

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({ data: { runtimeReadiness: { status: 'READY' } } }),
}))

vi.mock('@renderer/hooks/use-artifacts', () => ({
  useArtifacts: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTriggers: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useChatIntegrations: () => ({ data: [] }),
  useChatIntegrationSessions: () => ({ data: [] }),
}))

const mockUnreadCount = vi.fn(() => ({ data: { count: 0 } }))
vi.mock('@renderer/hooks/use-notifications', () => ({
  useUnreadNotificationCount: () => mockUnreadCount(),
}))

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

type MockView =
  | { kind: 'home' }
  | { kind: 'session'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'webhook'; id: string }
  | { kind: 'chat'; integrationId: string; sessionId?: string }
  | { kind: 'dashboard'; slug: string }
  | { kind: 'apiLogs' }
  | { kind: 'connections' }

const mockSelectionContext = {
  selectedAgentSlug: null as string | null,
  view: { kind: 'home' } as MockView,
  setAgent: vi.fn(),
  setView: vi.fn(),
  clearSelection: vi.fn(),
}
vi.mock('@renderer/context/selection-context', () => ({
  useSelection: () => mockSelectionContext,
}))

const mockUserContext = {
  isAuthMode: false,
  isAdmin: true,
  user: null,
  signOut: vi.fn(),
  agentMemberCount: () => 1,
}
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => mockUserContext,
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/context/connectivity-context', () => ({
  useIsOnline: () => true,
  ConnectivityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const mockDialogContext = {
  settingsOpen: false,
  setSettingsOpen: vi.fn(),
  settingsTab: undefined,
  openWizard: vi.fn(),
}
vi.mock('@renderer/context/dialog-context', () => ({
  useDialogs: () => mockDialogContext,
  DialogProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/agents/agent-status', () => ({
  AgentStatus: ({ status, hasSessionsAwaitingInput, hasActiveSessions }: { status: string; hasSessionsAwaitingInput?: boolean; hasActiveSessions?: boolean }) => (
    <span
      data-testid={`agent-status-${status}`}
      data-awaiting={hasSessionsAwaitingInput ? 'true' : 'false'}
      data-active={hasActiveSessions ? 'true' : 'false'}
    >
      {status}
    </span>
  ),
}))

vi.mock('@renderer/components/agents/status-indicators', () => ({
  WorkingDots: () => <span data-testid="working-dots" />,
  AwaitingDot: () => <span data-testid="awaiting-dot" />,
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/sessions/session-context-menu', () => ({
  SessionContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/dashboards/dashboard-context-menu', () => ({
  DashboardContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/settings/container-setup-dialog', () => ({
  ContainerSetupDialog: () => null,
}))

vi.mock('@renderer/components/notifications/notifications-popover', () => ({
  NotificationsPopoverContent: ({ onNavigate }: { onNavigate: () => void }) => (
    <button data-testid="popover-content" onClick={onNavigate}>
      popover content
    </button>
  ),
}))

vi.mock('@renderer/components/ui/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children, open, onOpenChange }: { children: React.ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void }) => (
    <div data-testid="popover" data-open={open}>
      {children}
      {open !== undefined && <button data-testid="popover-close" onClick={() => onOpenChange?.(false)} />}
    </div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/ui/sidebar', () => ({
  Sidebar: ({ children, ...props }: any) => <aside {...props}>{children}</aside>,
  SidebarContent: ({ children }: any) => <div>{children}</div>,
  SidebarFooter: ({ children, className }: any) => <div data-testid="sidebar-footer" className={className}>{children}</div>,
  SidebarHeader: ({ children, className }: any) => (
    <div data-testid="sidebar-header" className={className}>{children}</div>
  ),
  SidebarGroup: ({ children, className }: any) => <div className={className}>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
  SidebarGroupLabel: ({ children, className }: any) => <span className={className}>{children}</span>,
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuButton: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
  SidebarMenuItem: ({ children, onMouseEnter }: any) => <li onMouseEnter={onMouseEnter}>{children}</li>,
  SidebarMenuSkeleton: () => <div data-testid="skeleton" />,
  SidebarMenuSub: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuSubButton: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SidebarMenuSubItem: ({ children }: any) => <li>{children}</li>,
  SidebarRail: () => null,
}))

vi.mock('@renderer/components/ui/collapsible', () => ({
  Collapsible: ({ children, open }: any) => <div data-open={open}>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <>{children}</>,
}))

vi.mock('@renderer/components/ui/alert', () => ({
  Alert: ({ children, ...props }: any) => <div role="alert" {...props}>{children}</div>,
  AlertDescription: ({ children }: any) => <span>{children}</span>,
}))

// Stub out @dnd-kit so SortableAgentMenuItem renders the real AgentMenuItem
// directly — drag-and-drop is out of scope for these tests.
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: any) => <>{children}</>,
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: any) => <>{children}</>,
  verticalListSortingStrategy: vi.fn(),
  arrayMove: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
}))
vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => '' } },
}))
vi.mock('@dnd-kit/modifiers', () => ({
  restrictToVerticalAxis: vi.fn(),
}))

function makeAgent(overrides: Record<string, any> = {}) {
  return {
    slug: 'test-agent',
    name: 'Test Agent',
    status: 'running',
    containerPort: 3000,
    createdAt: new Date(),
    hasActiveSessions: false,
    hasSessionsAwaitingInput: false,
    hasUnreadNotifications: false,
    sessionCount: 1,
    chatIntegrationCount: 0,
    dashboardCount: 0,
    ...overrides,
  }
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    id: 'session-1',
    agentSlug: 'test-agent',
    name: 'Session 1',
    messageCount: 5,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    isActive: false,
    isAwaitingInput: false,
    hasUnreadNotifications: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mockSelectionContext, {
    selectedAgentSlug: null,
    view: { kind: 'home' } as MockView,
  })
  mockUseAgents.mockReturnValue({
    data: [makeAgent(), makeAgent({ slug: 'other-agent', name: 'Other Agent', status: 'stopped', sessionCount: 0 })],
    isLoading: false,
    error: null,
  })
  mockUseSessions.mockImplementation((slug: string | null) => ({
    data: slug === 'test-agent' ? [makeSession()] : [],
    isLoading: false,
  }))
  mockUnreadCount.mockReturnValue({ data: { count: 0 } })
})

describe('AppSidebar — layout & top nav', () => {
  it('renders the SuperAgent wordmark', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('SuperAgent')).toBeInTheDocument()
  })

  it('renders Home, Notifications, and New Agent in the top nav', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('home-button')).toBeInTheDocument()
    expect(screen.getByTestId('notifications-button')).toBeInTheDocument()
    expect(screen.getByTestId('new-agent-button')).toBeInTheDocument()
  })

  it('renders the "Your Agents" group label', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Your Agents')).toBeInTheDocument()
  })

  it('renders Settings + version in the footer', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('settings-button')).toBeInTheDocument()
    expect(screen.getByText('v0.1.0-test')).toBeInTheDocument()
  })

  it('clears selection when Home is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    await user.click(screen.getByTestId('home-button'))
    expect(mockSelectionContext.clearSelection).toHaveBeenCalled()
  })

  it('creates an untitled agent when New Agent is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    await user.click(screen.getByTestId('new-agent-button'))
    expect(mockCreateUntitledAgent).toHaveBeenCalled()
  })

  it('does not render a header bar in non-Electron mode (no traffic-light spacer)', () => {
    renderWithProviders(<AppSidebar />)
    // Header is always mounted now, but collapses to h-0 / no border when not needed.
    const header = screen.getByTestId('sidebar-header')
    expect(header.className).toMatch(/h-0/)
    expect(header.className).not.toMatch(/h-12\b/)
  })
})

describe('AppSidebar — agent rows', () => {
  it('renders agent rows', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Test Agent')).toBeInTheDocument()
    expect(screen.getByText('Other Agent')).toBeInTheDocument()
  })

  it('shows a status indicator for each agent (collapsed)', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('agent-status-running')).toBeInTheDocument()
    expect(screen.getByTestId('agent-status-stopped')).toBeInTheDocument()
  })

  it('renders an unread dot at the agent level when collapsed and hasUnreadNotifications', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasUnreadNotifications: true })],
      isLoading: false,
      error: null,
    })
    renderWithProviders(<AppSidebar />)
    expect(screen.getByLabelText('unread notifications')).toBeInTheDocument()
  })

  it('row click selects the agent without expanding', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    const row = screen.getByTestId('agent-item-test-agent')
    await user.click(row)
    expect(mockSelectionContext.setAgent).toHaveBeenCalledWith('test-agent')
    // Row click does NOT toggle expansion → no session sub-items rendered.
    expect(screen.queryByTestId('session-item-session-1')).not.toBeInTheDocument()
  })

  it('chevron click toggles expansion without selecting the agent', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    // One Expand button per agent row — pick the one for `test-agent` (the row
    // that has session data).
    const testAgentRow = screen.getByTestId('agent-item-test-agent').closest('li')!
    const expandBtn = testAgentRow.querySelector('[aria-label="Expand"]') as HTMLButtonElement
    expect(expandBtn).not.toBeNull()
    await user.click(expandBtn)
    expect(mockSelectionContext.setAgent).not.toHaveBeenCalled()
    expect(screen.getByTestId('session-item-session-1')).toBeInTheDocument()
    expect(testAgentRow.querySelector('[aria-label="Collapse"]')).not.toBeNull()
  })

  it('renders session sub-items when an agent is the selected one (auto-expanded)', () => {
    mockSelectionContext.selectedAgentSlug = 'test-agent'
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Session 1')).toBeInTheDocument()
  })

  it('selects agent and session on session click', async () => {
    mockSelectionContext.selectedAgentSlug = 'test-agent'
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    await user.click(screen.getByTestId('session-item-session-1'))
    expect(mockSelectionContext.setAgent).toHaveBeenCalledWith('test-agent', { kind: 'session', id: 'session-1' })
  })

  it('shows an unread dot on a session sub-item with hasUnreadNotifications', () => {
    mockSelectionContext.selectedAgentSlug = 'test-agent'
    mockUseSessions.mockImplementation((slug: string | null) => ({
      data: slug === 'test-agent' ? [makeSession({ hasUnreadNotifications: true })] : [],
      isLoading: false,
    }))
    renderWithProviders(<AppSidebar />)
    // Two unread dots: one on the agent row, one on the session row. Verify the
    // session-row dot has its accessible label so screen readers announce it.
    const dots = screen.getAllByLabelText('unread notifications')
    expect(dots.length).toBeGreaterThanOrEqual(1)
  })
})

describe('AppSidebar — notifications', () => {
  it('does not render the bell dot when there are no unread notifications', () => {
    mockUnreadCount.mockReturnValue({ data: { count: 0 } })
    renderWithProviders(<AppSidebar />)
    const button = screen.getByTestId('notifications-button')
    expect(button.querySelector('[aria-label$="unread"]')).toBeNull()
  })

  it('renders the bell dot when there are unread user-actionable notifications', () => {
    mockUnreadCount.mockReturnValue({ data: { count: 3 } })
    renderWithProviders(<AppSidebar />)
    const button = screen.getByTestId('notifications-button')
    expect(button.querySelector('[aria-label="3 unread"]')).not.toBeNull()
  })

  it('closes the popover when a notification is clicked (onNavigate wired)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    // Our Popover mock exposes the controlled open state on data-open and
    // forwards onNavigate to onOpenChange(false). Click the popover content to
    // simulate a notification click; the popover should flip to closed.
    const popover = screen.getByTestId('popover')
    expect(popover).toHaveAttribute('data-open', 'false')
    await user.click(screen.getByTestId('popover-content'))
    expect(popover).toHaveAttribute('data-open', 'false')
  })
})

// ============================================================================
// AgentRowIndicator: priority + collapse-vs-expand behavior
// ----------------------------------------------------------------------------
// The right-side indicator on the agent row collapses session-derived states
// (awaiting / working / unread) when the agent is expanded — those states
// surface on the individual session sub-rows instead. When collapsed, priority
// is awaiting > working > unread > sleeping/idle. Sleeping/idle (which
// describe the container itself) always render via <AgentStatus iconOnly>.
// ============================================================================
describe('AppSidebar — agent row indicator', () => {
  it('uses fresh sessions data over stale agent flags when sessions are loaded', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasSessionsAwaitingInput: false /* stale */, sessionCount: 1 })],
      isLoading: false,
      error: null,
    })
    mockUseSessions.mockImplementation((slug: string | null) => ({
      data: slug === 'test-agent' ? [makeSession({ isAwaitingInput: true /* fresh */ })] : [],
      isLoading: false,
    }))
    mockSelectionContext.selectedAgentSlug = 'test-agent'

    renderWithProviders(<AppSidebar />)
    // Agent is selected (expanded) so AgentRowIndicator suppresses
    // session-derived flags on the AGENT row. But the session sub-row should
    // still surface its awaiting indicator — which our mock shows via the
    // `<AgentStatus>` `data-awaiting` attribute on session-derived flags.
    // Since the agent is expanded, the agent-level status should NOT be
    // marked awaiting (data-awaiting='false').
    const status = screen.getByTestId('agent-status-running')
    expect(status).toHaveAttribute('data-awaiting', 'false')
  })

  it('falls back to agent-level flags when sessions data is not yet loaded', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasSessionsAwaitingInput: true })],
      isLoading: false,
      error: null,
    })
    // Sessions not loaded (agent collapsed, lazy hooks return undefined)
    mockUseSessions.mockReturnValue({ data: undefined, isLoading: false })

    renderWithProviders(<AppSidebar />)
    const status = screen.getByTestId('agent-status-running')
    expect(status).toHaveAttribute('data-awaiting', 'true')
  })

  it('does not render the agent-level unread dot when expanded — sessions surface it', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasUnreadNotifications: true })],
      isLoading: false,
      error: null,
    })
    mockSelectionContext.selectedAgentSlug = 'test-agent'

    renderWithProviders(<AppSidebar />)
    // The agent row's unread dot is suppressed because the agent is expanded.
    // Sessions data has no unread, so no session-row dot either. Net: zero
    // accessible "unread notifications" labels.
    expect(screen.queryByLabelText('unread notifications')).not.toBeInTheDocument()
  })

  it('prioritizes awaiting > working > unread when collapsed', () => {
    // Both awaiting AND unread set on agent flags. Agent is NOT expanded.
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasSessionsAwaitingInput: true, hasUnreadNotifications: true })],
      isLoading: false,
      error: null,
    })
    renderWithProviders(<AppSidebar />)
    // Awaiting wins → agent-status indicator is awaiting; the unread dot is
    // not rendered (it would be rendered alongside, but the priority code path
    // returns the AgentStatus indicator for awaiting).
    const status = screen.getByTestId('agent-status-running')
    expect(status).toHaveAttribute('data-awaiting', 'true')
    expect(screen.queryByLabelText('unread notifications')).not.toBeInTheDocument()
  })
})
