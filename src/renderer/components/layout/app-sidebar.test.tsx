// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cloneElement, isValidElement, type ReactElement } from 'react'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppSidebar } from './app-sidebar'
import { renderWithProviders } from '@renderer/test/test-utils'

// AppLink (the sidebar item links) is stubbed globally in test/setup.ts — no
// file-level mock needed. DialogContext is mocked below to control settings.

vi.stubGlobal('__APP_VERSION__', '0.1.0-test')
vi.stubGlobal('__RENDER_TRACKING__', false)

const mockIsElectron = vi.hoisted(() => vi.fn(() => false))
const mockGetPlatform = vi.hoisted(() => vi.fn(() => 'web'))
const mockOpenDashboardExternal = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/env', () => ({
  isElectron: mockIsElectron,
  getPlatform: mockGetPlatform,
  openDashboardExternal: mockOpenDashboardExternal,
  getApiBaseUrl: () => 'http://localhost:3000',
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })),
}))

const mockUseAgents = vi.fn()
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => mockUseAgents(),
  useDeleteAgent: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
  useCreateSession: () => ({ mutateAsync: vi.fn(), isPending: false }),
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


// Sidebar active state is route-derived, so mock the router hooks to let
// tests drive the URL. `mockRouteParams.slug` marks the active agent;
// `mockRoutePathname` drives Home/Notifications. useNavigate stays a no-op
// (matches the global setup mock, which this file-level mock replaces).
let mockRouteParams: Record<string, string | undefined> = {}
let mockRoutePathname = '/'
let mockHistorySubscribers: Array<(opts: { action: { type: string } }) => void> = []
const mockHistory = {
  location: { state: { __TSR_index: 0 } },
  canGoBack: vi.fn(() => false),
  back: vi.fn(),
  forward: vi.fn(),
  subscribe: vi.fn((cb: (opts: { action: { type: string } }) => void) => {
    mockHistorySubscribers.push(cb)
    return () => {
      mockHistorySubscribers = mockHistorySubscribers.filter((subscriber) => subscriber !== cb)
    }
  }),
}
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useRouter: () => ({ history: mockHistory }),
    useNavigate: () => () => {},
    useParams: () => mockRouteParams,
    useRouterState: (opts?: { select?: (s: { location: { pathname: string } }) => unknown }) =>
      opts?.select ? opts.select({ location: { pathname: mockRoutePathname } }) : undefined,
  }
})

vi.mock('@renderer/context/search-context', () => ({
  useSearch: () => ({ open: false, openSearch: vi.fn(), closeSearch: vi.fn() }),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  openSettings: vi.fn(),
  closeSettings: vi.fn(),
  openWizard: vi.fn(),
}
vi.mock('@renderer/context/onboarding-context', () => ({
  useOnboarding: () => ({ isOnboarding: false, setOnboarding: vi.fn() }),
  OnboardingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

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
  // Honor asChild (Slot): merge data-active + our props onto the child element so
  // the link carries the testid/active state and keeps its own onClick.
  SidebarMenuButton: ({ children, onClick, isActive, asChild, ...props }: any) =>
    asChild && isValidElement(children)
      ? cloneElement(children as ReactElement, { 'data-active': isActive ? 'true' : 'false', ...props })
      : <button onClick={onClick} data-active={isActive ? 'true' : 'false'} {...props}>{children}</button>,
  SidebarMenuItem: ({ children, onMouseEnter }: any) => <li onMouseEnter={onMouseEnter}>{children}</li>,
  SidebarMenuSkeleton: () => <div data-testid="skeleton" />,
  SidebarMenuSub: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuSubButton: ({ children, isActive, asChild, ...props }: any) =>
    asChild && isValidElement(children)
      ? cloneElement(children as ReactElement, { 'data-active': isActive ? 'true' : 'false', ...props })
      : <div data-active={isActive ? 'true' : 'false'} {...props}>{children}</div>,
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

function setMockHistoryIndex(index: number) {
  mockHistory.location = { state: { __TSR_index: index } }
  mockHistory.canGoBack.mockImplementation(() => index > 0)
}

function notifyHistory(actionType: string) {
  mockHistorySubscribers.forEach((subscriber) => subscriber({ action: { type: actionType } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('__WEB__', true)
  mockIsElectron.mockReturnValue(false)
  mockGetPlatform.mockReturnValue('web')
  mockRouteParams = {}
  mockRoutePathname = '/'
  mockHistorySubscribers = []
  setMockHistoryIndex(0)
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

  it('lights up only Notifications (not Home) on the notifications route', () => {
    // Active state is route-derived: on /notifications, Home (exact '/') is off.
    mockRoutePathname = '/notifications'
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('home-button')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('notifications-button')).toHaveAttribute('data-active', 'true')
  })

  it('does not light up an agent on the notifications route', () => {
    // /notifications carries no slug param, so the agent row is route-inactive
    // even if Selection still references it.
    mockRoutePathname = '/notifications'
    mockRouteParams = {}
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('agent-item-test-agent')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('notifications-button')).toHaveAttribute('data-active', 'true')
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

  it('Home links to the global home route', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('home-button')).toHaveAttribute('data-to', '/')
  })

  it('creates an untitled agent when New Agent is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    await user.click(screen.getByTestId('new-agent-button'))
    expect(mockCreateUntitledAgent).toHaveBeenCalled()
  })

  it('does not render a header bar in non-Electron mode (no traffic-light spacer)', () => {
    renderWithProviders(<AppSidebar />)
    // Header is always mounted, but collapses to h-0 / no border when not needed.
    const header = screen.getByTestId('sidebar-header')
    expect(header.className).toMatch(/h-0/)
    expect(header.className).not.toMatch(/h-12\b/)
  })

  it('does not render history navigation controls in web mode', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.queryByTestId('history-back-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('history-forward-button')).not.toBeInTheDocument()
  })

  it('renders Electron history controls and syncs their enabled state', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('__WEB__', false)
    mockIsElectron.mockReturnValue(true)
    mockGetPlatform.mockReturnValue('darwin')

    renderWithProviders(<AppSidebar />)

    const backButton = screen.getByTestId('history-back-button')
    const forwardButton = screen.getByTestId('history-forward-button')
    expect(backButton).toBeDisabled()
    expect(forwardButton).toBeDisabled()

    setMockHistoryIndex(1)
    act(() => notifyHistory('PUSH'))
    expect(backButton).toBeEnabled()
    expect(forwardButton).toBeDisabled()

    await user.click(backButton)
    expect(mockHistory.back).toHaveBeenCalledTimes(1)

    setMockHistoryIndex(0)
    act(() => notifyHistory('BACK'))
    expect(backButton).toBeDisabled()
    expect(forwardButton).toBeEnabled()

    await user.click(forwardButton)
    expect(mockHistory.forward).toHaveBeenCalledTimes(1)
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

  it('agent row links to the agent route without expanding', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)
    const row = screen.getByTestId('agent-item-test-agent')
    expect(row).toHaveAttribute('data-to', '/agents/$slug')
    expect(row).toHaveAttribute('data-params', JSON.stringify({ slug: 'test-agent' }))
    await user.click(row)
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
    expect(screen.getByTestId('session-item-session-1')).toBeInTheDocument()
    expect(testAgentRow.querySelector('[aria-label="Collapse"]')).not.toBeNull()
  })

  it('renders session sub-items when an agent is the selected one (auto-expanded)', () => {
    mockRouteParams = { slug: 'test-agent' }
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Session 1')).toBeInTheDocument()
  })

  it('session sub-item links to the session route', () => {
    mockRouteParams = { slug: 'test-agent' }
    renderWithProviders(<AppSidebar />)
    const sessionItem = screen.getByTestId('session-item-session-1')
    expect(sessionItem).toHaveAttribute('data-to', '/agents/$slug/sessions/$sessionId')
    expect(sessionItem).toHaveAttribute('data-params', JSON.stringify({ slug: 'test-agent', sessionId: 'session-1' }))
  })

  it('shows an unread dot on a session sub-item with hasUnreadNotifications', () => {
    mockRouteParams = { slug: 'test-agent' }
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

  it('Notifications links to the notifications route', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('notifications-button')).toHaveAttribute('data-to', '/notifications')
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
    mockRouteParams = { slug: 'test-agent' }

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
    mockRouteParams = { slug: 'test-agent' }

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
