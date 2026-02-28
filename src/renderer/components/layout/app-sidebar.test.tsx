// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: vi.fn(() => ({
    data: [
      {
        slug: 'test-agent',
        name: 'Test Agent',
        status: 'running',
        containerPort: 3000,
        createdAt: new Date(),
      },
      {
        slug: 'other-agent',
        name: 'Other Agent',
        status: 'stopped',
        containerPort: null,
        createdAt: new Date(),
      },
    ],
    isLoading: false,
    error: null,
  })),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: vi.fn((slug: string) => ({
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
  })),
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

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTasks: () => ({ data: [] }),
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
  setCreateAgentOpen: vi.fn(),
  openWizard: vi.fn(),
}
vi.mock('@renderer/context/dialog-context', () => ({
  useDialogs: () => mockDialogContext,
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
vi.mock('@renderer/components/agents/create-agent-dialog', () => ({
  CreateAgentDialog: () => null,
}))

vi.mock('@renderer/components/agents/agent-status', () => ({
  AgentStatus: ({ status }: { status: string }) => (
    <span data-testid={`agent-status-${status}`}>{status}</span>
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

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSelectionContext.selectedAgentSlug = null
    mockSelectionContext.selectedSessionId = null
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

  it('opens create agent dialog on button click', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AppSidebar />)

    await user.click(screen.getByTestId('create-agent-button'))
    expect(mockDialogContext.setCreateAgentOpen).toHaveBeenCalledWith(true)
  })

  it('renders session sub-items', () => {
    renderWithProviders(<AppSidebar />)
    expect(screen.getByText('Session 1')).toBeInTheDocument()
  })

  it('selects agent and session on session click', async () => {
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
})
