// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

if (typeof localStorage === 'undefined' || !localStorage) {
  const memory = new Map<string, string>()
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
    removeItem: (key: string) => { memory.delete(key) },
    clear: () => memory.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true })
}
import { cloneElement, isValidElement, type ReactElement } from 'react'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { pointerWithin } from '@dnd-kit/core'
import { AppSidebar } from './app-sidebar'
import { renderWithProviders } from '@renderer/test/test-utils'
import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { APP_VERSION } from '@shared/lib/config/version'
import { major, minor, patch } from 'semver'
// AppLink (the sidebar item links) is stubbed globally in test/setup.ts — no
// file-level mock needed. DialogContext is mocked below to control settings.

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
  // Resolve the route param to the canonical id the way the real hook does,
  // using the mocked params + agents so active-state tests behave faithfully.
  useRouteAgentId: () => {
    const slug = mockRouteParams.slug
    if (!slug) return undefined
    const agents = mockUseAgents()?.data as Array<{ slug: string; displaySlug: string }> | undefined
    return agents?.find((a) => a.slug === slug || a.displaySlug === slug)?.slug ?? slug
  },
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

const { mockUserSettings, mockUpdateSettings, dndContextProps } = vi.hoisted(() => ({
  mockUserSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
  // The latest props AppSidebar passed to the mocked DndContext, so tests can
  // drive the drag orchestration (collision detection → move → end) directly.
  dndContextProps: { current: null as any },
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: mockUserSettings() }),
  useUpdateUserSettings: () => ({ mutate: mockUpdateSettings }),
}))

const mockRuntimeStatus: { runtimeReadiness: { status: string }; appVersion?: string } = {
  runtimeReadiness: { status: 'READY' },
}
vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({ data: mockRuntimeStatus }),
}))

vi.mock('@renderer/hooks/use-artifacts', () => ({
  useArtifacts: () => ({ data: [] }),
}))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTriggers: () => ({ data: [] }),
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

const mockUpdateStatus: { state: string; version?: string } = { state: 'idle' }
vi.mock('@renderer/context/update-status-context', () => ({
  useUpdateStatus: () => mockUpdateStatus,
}))

const mockPlatformAuth: { platformBaseUrl?: string; orgId?: string } = {}
vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: mockPlatformAuth }),
}))

const mockOpenExternalUrl = vi.fn()
vi.mock('@renderer/lib/open-external', () => ({
  openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args),
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
  SessionContextMenu: ({
    children,
    isActive,
  }: {
    children: React.ReactNode
    isActive?: boolean
  }) => (
    isValidElement(children)
      ? cloneElement(children as ReactElement, { 'data-is-active': String(isActive) } as any)
      : <>{children}</>
  ),
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
  // Forwards `style` as well: the traffic-light reservation is an inline
  // paddingLeft, so a mock that dropped it would make that assertion vacuous.
  SidebarHeader: ({ children, className, style }: any) => (
    <div data-testid="sidebar-header" className={className} style={style}>{children}</div>
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
  useSidebar: () => ({ setOpenMobile: vi.fn() }),
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
  DndContext: (props: any) => {
    dndContextProps.current = props
    return <>{props.children}</>
  },
  DragOverlay: ({ children }: any) => <>{children}</>,
  MeasuringStrategy: { Always: 'always' },
  // Faithful enough for the sticky-snap tests: returns whatever candidates it
  // was given, nearest-first ordering not modeled (callers take [0]).
  closestCenter: vi.fn(({ droppableContainers }: any) =>
    (droppableContainers ?? []).map((d: any) => ({ id: d.id }))
  ),
  pointerWithin: vi.fn(() => []),
  rectIntersection: vi.fn(() => []),
  PointerSensor: vi.fn(),
  KeyboardSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  defaultDropAnimation: { duration: 250, easing: 'ease', keyframes: vi.fn(() => []) },
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
    setActivatorNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
    isOver: false,
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
    displaySlug: 'test-agent',
    name: 'Test Agent',
    status: 'running',
    containerPort: 3000,
    createdAt: new Date(),
    hasActiveSessions: false,
    hasSessionsAwaitingInput: false,
    hasUnreadNotifications: false,
    sessionCount: 1,
    dashboards: [],
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

const localStorageStore = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, String(value))
  },
  removeItem: (key: string) => {
    localStorageStore.delete(key)
  },
  clear: () => localStorageStore.clear(),
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorageStore.clear()
  vi.stubGlobal('localStorage', localStorageStub)
  vi.stubGlobal('__WEB__', true)
  mockIsElectron.mockReturnValue(false)
  mockGetPlatform.mockReturnValue('web')
  mockRouteParams = {}
  mockRoutePathname = '/'
  mockHistorySubscribers = []
  setMockHistoryIndex(0)
  _resetApiTargetForTest()
  setActiveTarget('local', null)
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
  mockUserSettings.mockReturnValue({ setupCompleted: true, agentOrder: [] })
  delete mockRuntimeStatus.appVersion
  mockRuntimeStatus.runtimeReadiness = { status: 'READY' }
  mockUpdateStatus.state = 'idle'
  delete mockUpdateStatus.version
  delete mockPlatformAuth.platformBaseUrl
  delete mockPlatformAuth.orgId
  mockOpenExternalUrl.mockReset()
})

describe('AppSidebar — layout & top nav', () => {
  it('restores the Gamut wordmark when browser chrome leaves the title bar empty', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Gamut')).toBeInTheDocument()
  })

  it('does not repeat the Gamut wordmark beside Electron window controls', () => {
    vi.stubGlobal('__WEB__', false)
    mockIsElectron.mockReturnValue(true)

    renderWithProviders(<AppSidebar />)
    expect(screen.queryByText('Gamut')).not.toBeInTheDocument()
  })

  it('puts the window-level controls in the title bar row', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('sidebar-header')).toContainElement(screen.getByTestId('search-button'))
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

  it('renders "Your Agents" as the default folder header', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('agent-folder-root')).toHaveTextContent('Your Agents')
  })

  it('renders Settings + version in the footer', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByTestId('settings-button')).toBeInTheDocument()
    expect(screen.getByText(`${APP_VERSION}`)).toBeInTheDocument()
  })

  it('keeps the local update tooltip and aria-label', () => {
    mockUpdateStatus.state = 'available'
    mockUpdateStatus.version = '1.2.3'

    renderWithProviders(<AppSidebar />)

    const label = screen.getByTestId('sidebar-version')
    expect(label).toHaveTextContent(`${APP_VERSION}`)
    expect(label.getAttribute('title')).toBe('Update available: v1.2.3')
    expect(screen.getByLabelText('Update available')).toBeInTheDocument()
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

  it('keeps the title bar row in non-Electron mode, minus the traffic-light spacer', () => {
    renderWithProviders(<AppSidebar />)
    // The row holds the controls now, so it exists everywhere; only the space
    // reserved for macOS traffic lights is conditional.
    const header = screen.getByTestId('sidebar-header')
    expect(header.className).toMatch(/h-12\b/)
    expect(header.style.paddingLeft).toBe('')
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

  it('agent with no sessions or dashboards does not render an expand chevron', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ sessionCount: 0, dashboards: [] })],
      isLoading: false,
      error: null,
    })
    renderWithProviders(<AppSidebar />)
    const agentRow = screen.getByTestId('agent-item-test-agent').closest('li')!
    expect(agentRow.querySelector('[aria-label="Expand"]')).toBeNull()
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
// The right-side indicator on the agent row aggregates awaiting / working
// across sessions with the same formula as the top-nav AgentStatus — the two
// render on the same screen and must agree. Only the unread dot is collapsed
// away when the agent is expanded (the session sub-rows surface it). Priority
// is awaiting > working > unread > sleeping/idle. Sleeping/idle (which
// describe the container itself) always render via <AgentStatus iconOnly>.
// ============================================================================
describe('AppSidebar — agent row indicator', () => {
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

  // Regression: the selected agent auto-expands, and the expanded agent row
  // used to zero out its working/awaiting state — while the top-nav
  // AgentStatus (agent-header) kept aggregating session activity. Same
  // screen, two answers: header said "working", sidebar row said idle. The
  // agent row must keep reporting working/awaiting when expanded.
  it('shows working on the expanded agent row when a session is active (top-nav parity)', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasActiveSessions: true })],
      isLoading: false,
      error: null,
    })
    mockUseSessions.mockImplementation((slug: string | null) => ({
      data: slug === 'test-agent' ? [makeSession({ isActive: true })] : [],
      isLoading: false,
    }))
    mockRouteParams = { slug: 'test-agent' }

    renderWithProviders(<AppSidebar />)
    // The agent is expanded — its session sub-row is visible and working…
    expect(screen.getByTestId('session-item-session-1')).toBeInTheDocument()
    expect(screen.getByTestId('session-item-session-1')).toHaveAttribute('data-is-active', 'true')
    // …and the agent row itself still reports working, like the top nav.
    const status = screen.getByTestId('agent-status-running')
    expect(status).toHaveAttribute('data-active', 'true')
  })

  it('shows awaiting on the expanded agent row when a session awaits input (top-nav parity)', () => {
    mockUseAgents.mockReturnValue({
      data: [makeAgent({ hasSessionsAwaitingInput: false /* stale */ })],
      isLoading: false,
      error: null,
    })
    mockUseSessions.mockImplementation((slug: string | null) => ({
      data: slug === 'test-agent' ? [makeSession({ isAwaitingInput: true /* fresh */ })] : [],
      isLoading: false,
    }))
    mockRouteParams = { slug: 'test-agent' }

    renderWithProviders(<AppSidebar />)
    const status = screen.getByTestId('agent-status-running')
    expect(status).toHaveAttribute('data-awaiting', 'true')
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

describe('UserMenu action for the current target', () => {
  // Cloud mode reports isAuthMode=true, which is what makes this menu appear at
  // all. "Sign out" there would revoke the deployment session the desktop's
  // grant is bound to — disruptive, and pointless since main still holds the
  // platform connection and would mint another.
  beforeEach(() => {
    mockUserContext.isAuthMode = true
    mockUserContext.user = { name: 'Ada' } as never
    _resetApiTargetForTest()
  })

  afterEach(() => {
    mockUserContext.isAuthMode = false
    mockUserContext.user = null
    vi.unstubAllGlobals()
    _resetApiTargetForTest()
  })

  async function openUserMenu() {
    renderWithProviders(<AppSidebar />)
    await userEvent.click(screen.getByTestId('user-menu-trigger'))
  }

  it('offers sign out for a web deployment', async () => {
    vi.stubGlobal('__AUTH_MODE__', true)
    setActiveTarget('local', null)

    await openUserMenu()

    expect(screen.getByTestId('sign-out-button')).toBeInTheDocument()
    expect(screen.queryByTestId('switch-to-local-button')).not.toBeInTheDocument()
  })

  it('offers a return to local for a cloud workspace, never sign out', async () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('cloud', null)

    await openUserMenu()

    expect(screen.getByTestId('switch-to-local-button')).toBeInTheDocument()
    expect(screen.queryByTestId('sign-out-button')).not.toBeInTheDocument()
  })

  it('does not revoke the deployment session when that action is used', async () => {
    vi.stubGlobal('__AUTH_MODE__', false)
    setActiveTarget('cloud', null)

    await openUserMenu()
    await userEvent.click(screen.getByTestId('switch-to-local-button'))

    expect(mockUserContext.signOut).not.toHaveBeenCalled()
  })
})

// The footer compares the deployment against `__APP_VERSION__`, which vitest
// defines as the real package version. Fixtures are therefore derived from it
// rather than written as literals: a hardcoded `0.5.13` reads as one patch
// behind today and a whole minor behind once the app ships 0.6.0, silently
// flipping the dot these tests assert on from blue to orange.
const MAJOR = major(APP_VERSION)
const MINOR = minor(APP_VERSION)
const PATCH = patch(APP_VERSION)

/** One patch ahead: differs from the desktop build, never behind it. */
const PATCH_AHEAD = `${MAJOR}.${MINOR}.${PATCH + 1}`
/** One patch behind — a prerelease of x.y.0 when there is no lower patch. */
const PATCH_BEHIND = PATCH > 0 ? `${MAJOR}.${MINOR}.${PATCH - 1}` : `${MAJOR}.${MINOR}.0-0`
/** A whole minor behind (a whole major, on an x.0.z build). */
const MINOR_BEHIND = MINOR > 0 ? `${MAJOR}.${MINOR - 1}.0` : `${MAJOR - 1}.0.0`
/** A whole minor ahead, and a whole major ahead. */
const MINOR_AHEAD = `${MAJOR}.${MINOR + 1}.0`
const MAJOR_AHEAD = `${MAJOR + 1}.0.0`

describe('footer version in cloud mode', () => {
  const desktopVersion = APP_VERSION

  beforeEach(() => {
    _resetApiTargetForTest()
    setActiveTarget('cloud', null)
  })

  afterEach(() => {
    delete mockRuntimeStatus.appVersion
    mockUpdateStatus.state = 'idle'
    delete mockUpdateStatus.version
  })

  it('shows one number when desktop and cloud match and no update is waiting', async () => {
    mockRuntimeStatus.appVersion = desktopVersion

    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('sidebar-version')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.queryByTestId('sidebar-version-desktop')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-version-cloud')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Update available')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Desktop update available')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('sidebar-version'))
    expect(mockDialogContext.openSettings).toHaveBeenCalledWith('general')
  })

  it('shows a quiet pair when they differ and nobody is behind', async () => {
    mockRuntimeStatus.appVersion = PATCH_AHEAD
    mockPlatformAuth.platformBaseUrl = 'https://platform.example'
    mockPlatformAuth.orgId = 'org_1'

    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('sidebar-version-desktop')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.getByTestId('sidebar-version-cloud')).toHaveTextContent(PATCH_AHEAD)
    expect(screen.queryByLabelText('Desktop update available')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Cloud update available')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('sidebar-version-desktop'))
    expect(mockDialogContext.openSettings).toHaveBeenCalledWith('general')

    await userEvent.click(screen.getByTestId('sidebar-version-cloud'))
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      'https://platform.example/dashboard/organizations/org_1?tab=cloud',
    )
  })

  it('puts a blue dot on cloud when it is a patch behind', () => {
    mockRuntimeStatus.appVersion = PATCH_BEHIND

    renderWithProviders(<AppSidebar />)

    const cloudDot = screen.getByLabelText('Cloud update available')
    expect(cloudDot).toHaveClass('bg-blue-500')
    expect(screen.queryByLabelText('Desktop update available')).not.toBeInTheDocument()
  })

  it('puts an orange dot on cloud when it is a major or minor behind', () => {
    mockRuntimeStatus.appVersion = MINOR_BEHIND

    renderWithProviders(<AppSidebar />)

    expect(screen.getByLabelText('Cloud update available')).toHaveClass('bg-orange-500')
    expect(screen.queryByLabelText('Desktop update available')).not.toBeInTheDocument()
  })

  it('puts an orange dot on desktop when the feed matches a newer cloud', () => {
    mockRuntimeStatus.appVersion = MINOR_AHEAD
    mockUpdateStatus.state = 'available'
    mockUpdateStatus.version = MINOR_AHEAD

    renderWithProviders(<AppSidebar />)

    expect(screen.getByLabelText('Desktop update available')).toHaveClass('bg-orange-500')
    expect(screen.queryByLabelText('Cloud update available')).not.toBeInTheDocument()
  })

  it('puts orange dots on both when they match and the feed is a major ahead', () => {
    mockRuntimeStatus.appVersion = desktopVersion
    mockUpdateStatus.state = 'available'
    mockUpdateStatus.version = MAJOR_AHEAD

    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('sidebar-version-desktop')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.getByTestId('sidebar-version-cloud')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.getByLabelText('Desktop update available')).toHaveClass('bg-orange-500')
    expect(screen.getByLabelText('Cloud update available')).toHaveClass('bg-orange-500')
  })

  it('keeps one number and a desktop update dot when they match the feed', () => {
    mockRuntimeStatus.appVersion = desktopVersion
    mockUpdateStatus.state = 'available'
    mockUpdateStatus.version = desktopVersion

    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('sidebar-version')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.queryByTestId('sidebar-version-cloud')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Desktop update available')).toHaveClass('bg-blue-500')
  })

  it('falls back to the desktop number when the deployment omits appVersion', () => {
    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('sidebar-version')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.queryByTestId('sidebar-version-cloud')).not.toBeInTheDocument()
  })

  it('falls back to the desktop number when appVersion is not a version', () => {
    mockRuntimeStatus.appVersion = 'not-a-version'

    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('sidebar-version')).toHaveTextContent(`${desktopVersion}`)
    expect(screen.queryByTestId('sidebar-version-cloud')).not.toBeInTheDocument()
  })

  it('does not open the cloud tab when org is missing', async () => {
    mockRuntimeStatus.appVersion = PATCH_AHEAD
    mockPlatformAuth.platformBaseUrl = 'https://platform.example'

    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('sidebar-version-cloud'))
    expect(mockOpenExternalUrl).not.toHaveBeenCalled()
  })
})

describe('TargetSwitcher placement', () => {
  // It scopes everything below it, so it belongs at the head of the sidebar's
  // title bar row — not in the footer among the per-window actions.
  afterEach(() => {
    vi.unstubAllGlobals()
    _resetApiTargetForTest()
  })

  it('sits above the Home item, not below the agent list', () => {
    renderWithProviders(<AppSidebar />)

    const switcher = screen.queryByTestId('target-switcher')
    if (!switcher) return // hidden without a cloud workspace, covered elsewhere

    const home = screen.getByTestId('home-button')
    // DOCUMENT_POSITION_FOLLOWING: home comes after the switcher.
    expect(switcher.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves no padded gap when there is no cloud workspace to switch to', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.queryByTestId('target-switcher')).not.toBeInTheDocument()
  })
})

describe('AppSidebar — agent folders', () => {
  const FOLDERS = [
    { id: 'f1', name: 'Work' },
    { id: 'f2', name: 'Personal' },
  ]
  const FOLDER_1 = 'agent-folder::f1'
  const FOLDER_2 = 'agent-folder::f2'
  const ROOT = 'agent-folder::root'

  function withThreeAgents() {
    mockUseAgents.mockReturnValue({
      data: [
        makeAgent(),
        makeAgent({ slug: 'other-agent', name: 'Other Agent' }),
        makeAgent({ slug: 'third-agent', name: 'Third Agent' }),
      ],
      isLoading: false,
      error: null,
    })
  }

  /**
   * The left nav top to bottom: agent slugs and `folder:<id>` in DOM order,
   * which is the order the user reads them in.
   */
  function listOrder(): string[] {
    return Array.from(
      document.querySelectorAll('[data-testid^="agent-item-"], [data-testid^="agent-folder-"]')
    )
      .map((el) => el.getAttribute('data-testid')!)
      .filter(
        (id) =>
          !id.startsWith('agent-folder-empty-') &&
          !id.startsWith('agent-folder-count-') &&
          !id.startsWith('agent-folder-chevron-')
      )
      .map((id) =>
        id.startsWith('agent-item-')
          ? id.replace('agent-item-', '')
          : id.replace('agent-folder-', 'folder:')
      )
  }

  it('renders every agent under the always-present default folder', () => {
    renderWithProviders(<AppSidebar />)
    expect(listOrder()).toEqual(['folder:root', 'test-agent', 'other-agent'])
    expect(screen.getByTestId('agent-folder-root')).toHaveTextContent('Your Agents')
  })

  it('renders a folder with its name and how many agents are in it', () => {
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentFolderAssignments: { 'test-agent': 'f1', 'other-agent': 'f1' },
    })
    renderWithProviders(<AppSidebar />)

    const folder = screen.getByTestId('agent-folder-f1')
    expect(folder).toHaveTextContent('Work')
    expect(folder).toHaveTextContent('2')
  })

  it('defaults the default folder first before anything is arranged', () => {
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentFolderAssignments: { 'test-agent': 'f1' },
    })
    renderWithProviders(<AppSidebar />)

    expect(listOrder()).toEqual(['folder:root', 'other-agent', 'folder:f1', 'test-agent'])
  })

  it('lets the default folder be placed among the others', () => {
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentFolderAssignments: { 'other-agent': 'f1' },
      agentListOrder: [FOLDER_1, ROOT],
    })
    renderWithProviders(<AppSidebar />)

    expect(listOrder()).toEqual(['folder:f1', 'other-agent', 'folder:root', 'test-agent'])
  })

  it('orders several folders by the stored order', () => {
    withThreeAgents()
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent', 'third-agent'],
      agentFolders: FOLDERS,
      agentFolderAssignments: { 'other-agent': 'f1' },
      agentListOrder: [FOLDER_2, ROOT, FOLDER_1],
    })
    renderWithProviders(<AppSidebar />)

    expect(listOrder()).toEqual([
      'folder:f2', 'folder:root', 'test-agent', 'third-agent', 'folder:f1', 'other-agent',
    ])
  })

  it('ignores stored order entries in the old interleaved format', () => {
    // The top level used to store agent slugs between folder markers; those
    // blobs must render under the new model with folders keeping their order.
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentListOrder: ['test-agent', FOLDER_1, 'other-agent'],
    })
    renderWithProviders(<AppSidebar />)

    // The slug entries are ignored; the unmarked default folder ranks first.
    expect(listOrder()).toEqual(['folder:root', 'test-agent', 'other-agent', 'folder:f1'])
  })

  it('hides a collapsed folder’s agents but keeps its header', () => {
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentFolderAssignments: { 'test-agent': 'f1' },
      collapsedAgentFolders: ['f1'],
    })
    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('agent-folder-f1')).toBeInTheDocument()
    // Hidden, not unmounted — expanding a big folder must not mount every row.
    expect(screen.getByTestId('agent-item-test-agent')).not.toBeVisible()
    expect(screen.getByTestId('agent-item-other-agent')).toBeVisible()
  })

  it('collapses the default folder too, and records it in settings', async () => {
    mockUserSettings.mockReturnValue({ agentOrder: ['test-agent', 'other-agent'] })
    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('agent-folder-root'))

    expect(mockUpdateSettings).toHaveBeenCalledWith(
      { collapsedAgentFolders: ['root'] },
      expect.anything()
    )
    // Painted locally rather than waiting on the write, so it feels instant
    // even against a cloud workspace.
    expect(screen.getByTestId('agent-item-test-agent')).not.toBeVisible()
  })

  it('shows an agent whose folder was deleted under the default folder', () => {
    // Deleting a folder leaves dangling assignments on purpose — this is the
    // behaviour that lets folder and agent deletion skip a cascade.
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [],
      agentFolderAssignments: { 'test-agent': 'deleted-folder' },
    })
    renderWithProviders(<AppSidebar />)

    expect(listOrder()).toEqual(['folder:root', 'test-agent', 'other-agent'])
  })

  // Folder create/rename use the updater form — a function of the latest
  // cached settings, resolved when the serialized mutation runs — so tests
  // resolve the captured payload against explicit "current" settings.
  const patchWith = (settings: Record<string, unknown>, call = 0) => {
    const arg = mockUpdateSettings.mock.calls[call][0]
    return typeof arg === 'function' ? arg(settings) : arg
  }

  it('adds a uniquely-named folder from the default folder’s header', async () => {
    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('new-folder-button'))

    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const patch = patchWith({ agentFolders: [] })
    expect(patch.agentFolders).toHaveLength(1)
    expect(patch.agentFolders[0].name).toBe('New Folder')
    expect(patch.agentFolders[0].id).toBeTruthy()
  })

  it('does not reuse an existing folder name when adding another', async () => {
    const settings = {
      agentOrder: [],
      agentFolders: [{ id: 'f1', name: 'New Folder' }],
    }
    mockUserSettings.mockReturnValue(settings)
    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('new-folder-button'))

    const patch = patchWith(settings)
    expect(patch.agentFolders[1].name).toBe('New Folder 2')
  })

  it('names a created folder against the folder list at mutation run time', async () => {
    // A create queued behind an in-flight write resolves after it settles: if
    // that write added "New Folder", this one must come out "New Folder 2" —
    // and must carry the other write's folder rather than reverting it.
    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('new-folder-button'))

    const patch = patchWith({ agentFolders: [{ id: 'f9', name: 'New Folder' }] })
    expect(patch.agentFolders).toHaveLength(2)
    expect(patch.agentFolders[0]).toEqual({ id: 'f9', name: 'New Folder' })
    expect(patch.agentFolders[1].name).toBe('New Folder 2')
  })

  it('renders a folder with no recorded place at the end of the list', () => {
    // The read-side fallback doubles as the upgrade path for folders stored
    // before places existed; creation itself now records a place up front.
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentListOrder: [ROOT],
    })
    renderWithProviders(<AppSidebar />)

    expect(listOrder()).toEqual(['folder:root', 'test-agent', 'other-agent', 'folder:f1'])
  })

  it('places a created folder directly above the default folder', async () => {
    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('new-folder-button'))

    // Untouched install: no stored places yet, so root's marker is written
    // too — without one it would default ahead of the new folder (place -1).
    const fresh = patchWith({ agentFolders: [] })
    expect(fresh.agentListOrder).toEqual([
      `agent-folder::${fresh.agentFolders[0].id}`,
      ROOT,
    ])

    // A root the user moved off the top stays put; the new folder splices in
    // just above it and other folders keep their places.
    const arranged = patchWith({
      agentFolders: [FOLDERS[0]],
      agentListOrder: ['agent-folder::f1', ROOT],
    })
    expect(arranged.agentListOrder).toEqual([
      'agent-folder::f1',
      `agent-folder::${arranged.agentFolders[1].id}`,
      ROOT,
    ])
  })

  it('still renders folders when the user has no agents at all', () => {
    // The "No agents yet" empty state must not swallow the folder the user
    // just created on an empty install.
    mockUseAgents.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUserSettings.mockReturnValue({ agentOrder: [], agentFolders: [FOLDERS[0]] })
    renderWithProviders(<AppSidebar />)

    expect(screen.getByTestId('agent-folder-f1')).toBeInTheDocument()
    expect(screen.queryByText('No agents yet. Create one to get started.')).not.toBeInTheDocument()
  })

  it('keeps the empty state when there are neither agents nor folders', () => {
    mockUseAgents.mockReturnValue({ data: [], isLoading: false, error: null })
    renderWithProviders(<AppSidebar />)

    expect(screen.getByText('No agents yet. Create one to get started.')).toBeInTheDocument()
  })

  it('invites a drop into an empty folder', () => {
    mockUserSettings.mockReturnValue({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [FOLDERS[0]],
      agentFolderAssignments: {},
    })
    renderWithProviders(<AppSidebar />)

    expect(screen.getByText('Drag agents here')).toBeInTheDocument()
  })
})


describe('AppSidebar — drag orchestration', () => {
  // These drive the real handlers through the props AppSidebar hands the
  // (mocked) DndContext: collision detection computes the folder drop cue,
  // onDragMove commits it for the insert line, onDragEnd resolves the drop.
  const dnd = () => dndContextProps.current

  const folderBlock = (folderId: string, top: number, height = 40) => ({
    id: `agent-folder::${folderId}`,
    data: { current: { type: 'folder' } },
    rect: { current: { top, bottom: top + height, height, left: 0, right: 200, width: 200 } },
  })

  const folderActive = (folderId: string) => ({
    id: `agent-folder::${folderId}`,
    data: { current: { type: 'folder', folderId } },
  })

  const agentActive = (slug: string) => ({
    id: slug,
    data: { current: { type: 'agent' } },
  })

  const patchWith = (settings: Record<string, unknown>, call = 0) => {
    const arg = mockUpdateSettings.mock.calls[call][0]
    return typeof arg === 'function' ? arg(settings) : arg
  }

  const THREE_FOLDERS = [
    { id: 'f1', name: 'A' },
    { id: 'f2', name: 'B' },
    { id: 'f3', name: 'C' },
  ]
  const THREE_FOLDER_ORDER = [
    'agent-folder::root',
    'agent-folder::f1',
    'agent-folder::f2',
    'agent-folder::f3',
  ]
  const THREE_FOLDER_BLOCKS = [
    folderBlock('root', 0),
    folderBlock('f1', 40),
    folderBlock('f2', 80),
    folderBlock('f3', 120),
  ]

  function renderThreeFolders() {
    const settings = {
      setupCompleted: true,
      agentOrder: [],
      agentFolders: THREE_FOLDERS,
      agentListOrder: THREE_FOLDER_ORDER,
    }
    mockUserSettings.mockReturnValue(settings)
    renderWithProviders(<AppSidebar />)
    return settings
  }

  /** Run one collision pass with the pointer over `folderId` at height `y`. */
  function hoverFolder(active: any, folderId: string, y: number) {
    vi.mocked(pointerWithin).mockReturnValueOnce([{ id: `agent-folder::${folderId}` }])
    dnd().collisionDetection({
      active,
      droppableContainers: THREE_FOLDER_BLOCKS,
      pointerCoordinates: { x: 10, y },
    })
  }

  it('lands a folder dragged DOWN on the upper half where the line showed, before the target', () => {
    // The two quadrants the E2E does not walk (down+above, up+below) are
    // exactly where cue semantics and "take the target's slot" disagree — a
    // drop handler that loses the cue still passes the other two by luck.
    const settings = renderThreeFolders()
    const active = folderActive('f1')

    act(() => dnd().onDragStart({ active }))
    hoverFolder(active, 'f3', 125) // upper half of f3 (120..160)
    act(() => dnd().onDragMove({}))
    const line = screen.getByTestId('folder-insert-indicator-f3')
    expect(line).toHaveAttribute('data-edge', 'above')
    act(() => dnd().onDragEnd({ active, over: { id: 'agent-folder::f3' } }))

    expect(patchWith(settings).agentListOrder).toEqual([
      'agent-folder::root',
      'agent-folder::f2',
      'agent-folder::f1',
      'agent-folder::f3',
    ])
  })

  it('lands a folder dragged UP on the lower half where the line showed, after the target', () => {
    const settings = renderThreeFolders()
    const active = folderActive('f3')

    act(() => dnd().onDragStart({ active }))
    hoverFolder(active, 'f1', 75) // lower half of f1 (40..80)
    act(() => dnd().onDragMove({}))
    expect(screen.getByTestId('folder-insert-indicator-f1')).toHaveAttribute('data-edge', 'below')
    act(() => dnd().onDragEnd({ active, over: { id: 'agent-folder::f1' } }))

    expect(patchWith(settings).agentListOrder).toEqual([
      'agent-folder::root',
      'agent-folder::f1',
      'agent-folder::f3',
      'agent-folder::f2',
    ])
  })

  it('falls back to slot semantics without a pointer cue, as keyboard drags have none', () => {
    const settings = renderThreeFolders()
    const active = folderActive('f3')

    act(() => dnd().onDragStart({ active }))
    act(() => dnd().onDragEnd({ active, over: { id: 'agent-folder::f1' } }))

    expect(patchWith(settings).agentListOrder).toEqual([
      'agent-folder::root',
      'agent-folder::f3',
      'agent-folder::f1',
      'agent-folder::f2',
    ])
  })

  it('keeps a collapsed folder header as the drop target instead of its hidden rows', () => {
    // Hidden member rows measure 0×0 — inert for containment/overlap
    // detectors but perfectly valid for the DISTANCE snap. Unfiltered, the
    // snap steals `over` from the header one tick after the live re-parent,
    // killing the drop highlight and landing the agent at the hidden row's
    // index instead of appending.
    mockUserSettings.mockReturnValue({
      setupCompleted: true,
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { 'test-agent': 'f1' },
      agentListOrder: ['agent-folder::root', 'agent-folder::f1'],
      collapsedAgentFolders: ['f1'],
    })
    renderWithProviders(<AppSidebar />)

    const active = agentActive('test-agent')
    const collapsedBlock = folderBlock('f1', 40)
    const hiddenRow = {
      id: 'test-agent',
      data: { current: { type: 'agent' } },
      rect: { current: { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 } },
    }
    act(() => dnd().onDragStart({ active }))
    vi.mocked(pointerWithin).mockReturnValueOnce([{ id: 'agent-folder::f1' }])
    const result = dnd().collisionDetection({
      active,
      droppableContainers: [folderBlock('root', 0), collapsedBlock, hiddenRow],
      pointerCoordinates: { x: 10, y: 60 },
    })

    expect(result.map((c: any) => c.id)).toEqual(['agent-folder::f1'])
  })

  it("a drop's write keeps a folder created while the drop was in flight", () => {
    // The drop below was aimed while settings held [root,f1,f2,f3]; by the
    // time its (scope-serialized) write runs, a concurrent create added f9.
    // Writing the drop's snapshot back would erase f9 — the write must
    // re-apply the drop to the settings it actually lands on.
    renderThreeFolders()
    const active = folderActive('f1')

    act(() => dnd().onDragStart({ active }))
    hoverFolder(active, 'f3', 125)
    act(() => dnd().onDragEnd({ active, over: { id: 'agent-folder::f3' } }))

    const patch = patchWith({
      agentOrder: [],
      agentFolders: [...THREE_FOLDERS, { id: 'f9', name: 'Fresh' }],
      agentListOrder: [...THREE_FOLDER_ORDER, 'agent-folder::f9'],
    })
    expect(patch.agentFolders.map((f: { id: string }) => f.id)).toContain('f9')
    expect(patch.agentListOrder).toEqual([
      'agent-folder::root',
      'agent-folder::f2',
      'agent-folder::f1',
      'agent-folder::f3',
      'agent-folder::f9',
    ])
  })

  it("a drop's write keeps a filing made while the drop was in flight", () => {
    // While the drop's write was queued, a context-menu filing moved
    // test-agent into f1. The drop recorded other-agent's FINAL place (top of
    // "Your Agents" — the place the user saw it land), so the write puts it
    // there and carries the concurrent filing. The pre-fix snapshot write
    // carried the pre-drag assignment map instead, silently un-filing
    // test-agent.
    mockUserSettings.mockReturnValue({
      setupCompleted: true,
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentListOrder: ['agent-folder::root', 'agent-folder::f1'],
    })
    renderWithProviders(<AppSidebar />)

    const active = agentActive('other-agent')
    act(() => dnd().onDragStart({ active }))
    act(() => dnd().onDragEnd({ active, over: { id: 'test-agent' } }))

    const patch = patchWith({
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentFolderAssignments: { 'test-agent': 'f1' },
      agentListOrder: ['agent-folder::root', 'agent-folder::f1'],
    })
    expect(patch.agentFolderAssignments).toEqual({ 'test-agent': 'f1' })
    expect(patch.agentOrder[0]).toBe('other-agent')
  })

  it('puts a live cross-folder re-parent back where it was when the drag cancels', () => {
    mockUserSettings.mockReturnValue({
      setupCompleted: true,
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentListOrder: ['agent-folder::root', 'agent-folder::f1'],
    })
    renderWithProviders(<AppSidebar />)
    const active = agentActive('test-agent')

    act(() => dnd().onDragStart({ active }))
    act(() => dnd().onDragOver({ active, over: { id: 'agent-section::f1' } }))
    expect(listOrderOf()).toEqual(['folder:root', 'other-agent', 'folder:f1', 'test-agent'])

    act(() => dnd().onDragCancel())
    expect(listOrderOf()).toEqual(['folder:root', 'test-agent', 'other-agent', 'folder:f1'])
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })

  it("an older drop settling does not clear a newer drop's optimistic tree", () => {
    mockUseAgents.mockReturnValue({
      data: [
        makeAgent(),
        makeAgent({ slug: 'other-agent', name: 'Other Agent' }),
        makeAgent({ slug: 'third-agent', name: 'Third Agent' }),
      ],
      isLoading: false,
      error: null,
    })
    mockUserSettings.mockReturnValue({
      setupCompleted: true,
      agentOrder: ['test-agent', 'other-agent', 'third-agent'],
    })
    renderWithProviders(<AppSidebar />)

    const first = agentActive('third-agent')
    act(() => dnd().onDragStart({ active: first }))
    act(() => dnd().onDragEnd({ active: first, over: { id: 'test-agent' } }))
    const second = agentActive('other-agent')
    act(() => dnd().onDragStart({ active: second }))
    act(() => dnd().onDragEnd({ active: second, over: { id: 'third-agent' } }))
    expect(listOrderOf()).toEqual(['folder:root', 'other-agent', 'third-agent', 'test-agent'])

    // The FIRST drop's write settles now, after the second was issued. Its
    // stale token must not tear down the second drop's optimistic view.
    act(() => mockUpdateSettings.mock.calls[0][1].onSettled())
    expect(listOrderOf()).toEqual(['folder:root', 'other-agent', 'third-agent', 'test-agent'])
  })

  it("a drop settling mid-drag does not clear the active drag's re-parent", () => {
    mockUserSettings.mockReturnValue({
      setupCompleted: true,
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [{ id: 'f1', name: 'Work' }],
      agentListOrder: ['agent-folder::root', 'agent-folder::f1'],
    })
    renderWithProviders(<AppSidebar />)

    const first = agentActive('other-agent')
    act(() => dnd().onDragStart({ active: first }))
    act(() => dnd().onDragEnd({ active: first, over: { id: 'test-agent' } }))
    expect(listOrderOf()).toEqual(['folder:root', 'other-agent', 'test-agent', 'folder:f1'])

    // A second drag is live and has re-parented a row when the drop's write
    // settles. Over-change events only fire when `over` CHANGES, so a
    // mid-drag snap-back would stick for the rest of the drag.
    const second = agentActive('test-agent')
    act(() => dnd().onDragStart({ active: second }))
    act(() => dnd().onDragOver({ active: second, over: { id: 'agent-section::f1' } }))
    act(() => mockUpdateSettings.mock.calls[0][1].onSettled())
    expect(listOrderOf()).toEqual(['folder:root', 'other-agent', 'folder:f1', 'test-agent'])
  })

  it('an earlier collapse settling does not reopen a folder collapsed after it', async () => {
    mockUserSettings.mockReturnValue({
      setupCompleted: true,
      agentOrder: ['test-agent', 'other-agent'],
      agentFolders: [
        { id: 'f1', name: 'Work' },
        { id: 'f2', name: 'Personal' },
      ],
      agentFolderAssignments: { 'test-agent': 'f1', 'other-agent': 'f2' },
    })
    renderWithProviders(<AppSidebar />)

    await userEvent.click(screen.getByTestId('agent-folder-f1'))
    await userEvent.click(screen.getByTestId('agent-folder-f2'))
    expect(screen.getByTestId('agent-item-other-agent')).not.toBeVisible()

    // The first toggle's write settles after the second was issued; its stale
    // token must not drop the fold back to the cached (all-open) state.
    act(() => mockUpdateSettings.mock.calls[0][1].onSettled())
    expect(screen.getByTestId('agent-item-other-agent')).not.toBeVisible()
  })

  /** Same reading as the folders describe's listOrder, local to this one. */
  function listOrderOf(): string[] {
    return Array.from(
      document.querySelectorAll('[data-testid^="agent-item-"], [data-testid^="agent-folder-"]')
    )
      .map((el) => el.getAttribute('data-testid')!)
      .filter(
        (id) =>
          !id.startsWith('agent-folder-empty-') &&
          !id.startsWith('agent-folder-count-') &&
          !id.startsWith('agent-folder-chevron-') &&
          !id.startsWith('agent-folder-insert-indicator-')
      )
      .map((id) =>
        id.startsWith('agent-item-')
          ? id.replace('agent-item-', '')
          : id.replace('agent-folder-', 'folder:')
      )
  }
})
