// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AgentHeader } from './agent-header'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { HOVER_SCROLL_DELAY_MS } from '@renderer/components/ui/hover-scroll-text'
import {
  DashboardHeaderProvider,
  useRegisterDashboardHeader,
  type DashboardHeaderRegistration,
} from '@renderer/context/dashboard-header-context'

const mocks = vi.hoisted(() => ({
  routeView: { kind: 'session', id: 'session-1' } as {
    kind: string
    id?: string
    slug?: string
  },
}))

const agent: ApiAgent = {
  slug: 'test-agent',
  displaySlug: 'test-agent',
  name: 'Test Agent',
  description: 'A test agent',
  createdAt: new Date('2025-01-01'),
  status: 'running',
  containerPort: 3000,
}

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ view: mocks.routeView }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: agent }),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSessions: () => ({ data: [] }),
  useSession: () => ({
    data: {
      id: 'session-1',
      name: 'Test Session',
      agentSlug: 'test-agent',
    },
  }),
}))

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTask: () => ({ data: undefined }),
}))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTrigger: () => ({ data: undefined }),
}))

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({
    data: {
      runtimeReadiness: { status: 'READY', message: 'Ready' },
      apiKeyConfigured: true,
    },
    isPending: false,
  }),
}))

vi.mock('@renderer/components/ui/app-link', () => ({
  AppLink: ({
    children,
    className,
    'data-testid': testId,
  }: {
    children: ReactNode
    className?: string
    'data-testid'?: string
  }) => <a href="/agents/test-agent" className={className} data-testid={testId}>{children}</a>,
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ agent, children }: { agent: ApiAgent; children: ReactNode }) => (
    <span data-testid="agent-breadcrumb-context-menu" data-agent-slug={agent.slug}>{children}</span>
  ),
}))

vi.mock('@renderer/components/sessions/session-context-menu', () => ({
  SessionContextMenu: ({
    sessionId,
    sessionName,
    agentSlug,
    children,
  }: {
    sessionId: string
    sessionName: string
    agentSlug: string
    children: ReactNode
  }) => (
    <span
      data-testid="session-breadcrumb-context-menu"
      data-session-id={sessionId}
      data-session-name={sessionName}
      data-agent-slug={agentSlug}
    >
      {children}
    </span>
  ),
}))

const dashboardRegistration: DashboardHeaderRegistration = {
  agentSlug: 'test-agent',
  dashboardSlug: 'nutrition',
  dashboardName: 'Nutrition Dashboard',
  actions: {
    onOpenExternal: vi.fn(),
    onRefresh: vi.fn(),
    refreshState: 'idle',
  },
}

function RegisterDashboardHeader() {
  useRegisterDashboardHeader(dashboardRegistration)
  return null
}

describe('AgentHeader breadcrumbs', () => {
  beforeEach(() => {
    mocks.routeView = { kind: 'session', id: 'session-1' }
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses the agent and session context menus on their breadcrumbs', () => {
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    const agentMenu = screen.getByTestId('agent-breadcrumb-context-menu')
    expect(agentMenu).toHaveAttribute('data-agent-slug', 'test-agent')
    expect(agentMenu).toContainElement(screen.getByTestId('agent-breadcrumb'))

    const sessionMenu = screen.getByTestId('session-breadcrumb-context-menu')
    expect(sessionMenu).toHaveAttribute('data-session-id', 'session-1')
    expect(sessionMenu).toHaveAttribute('data-session-name', 'Test Session')
    expect(sessionMenu).toHaveAttribute('data-agent-slug', 'test-agent')
    expect(sessionMenu).toContainElement(screen.getByTestId('session-breadcrumb'))
  })

  it('clips and hover-scrolls the complete breadcrumb trail as one unit', () => {
    vi.useFakeTimers()
    const mutation = { mutate: vi.fn(), isPending: false }
    const { container } = render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    const trail = screen.getByTestId('breadcrumb-trail')
    const content = trail.firstElementChild as HTMLElement
    const agentCrumb = screen.getByTestId('agent-breadcrumb')
    const sessionCrumb = screen.getByTestId('session-breadcrumb')

    expect(trail).toHaveClass('hover-scroll-text')
    expect(container.querySelectorAll('.hover-scroll-text')).toHaveLength(1)
    expect(content).toHaveClass('hover-scroll-text-content', 'truncate')
    expect(content).toContainElement(agentCrumb)
    expect(content).toContainElement(sessionCrumb)
    expect(agentCrumb).not.toHaveClass('truncate')
    expect(sessionCrumb).not.toHaveClass('truncate')

    Object.defineProperty(trail, 'clientWidth', { configurable: true, value: 120 })
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 300 })
    fireEvent.mouseEnter(trail)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))

    expect(trail).toHaveAttribute('data-scrolling', 'true')
    expect(trail).toHaveStyle({ '--hover-scroll-distance': '180px' })
  })

  it('renders the dashboard name as a breadcrumb and its actions in the shared toolbar', () => {
    mocks.routeView = { kind: 'dashboard', slug: 'nutrition' }
    const mutation = { mutate: vi.fn(), isPending: false }

    const { container } = render(
      <DashboardHeaderProvider>
        <AgentHeader
          slug="test-agent"
          isViewOnly={false}
          startAgent={mutation as never}
          stopAgent={mutation as never}
        />
        <RegisterDashboardHeader />
      </DashboardHeaderProvider>,
    )

    expect(screen.getByTestId('dashboard-breadcrumb')).toHaveTextContent('Nutrition Dashboard')
    expect(screen.getByTestId('dashboard-header-actions')).toBeInTheDocument()

    const separators = container.querySelectorAll('[data-orientation="vertical"]')
    expect(separators).toHaveLength(2)
    expect(separators[0].className).toBe(separators[1].className)
    expect(separators[0]).not.toHaveClass('ml-2')
  })
})
