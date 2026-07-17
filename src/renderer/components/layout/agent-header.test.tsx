// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AgentHeader } from './agent-header'
import type { ApiAgent } from '@renderer/hooks/use-agents'

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
  useRouteLocation: () => ({ view: { kind: 'session', id: 'session-1' } }),
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
    <div data-testid="agent-breadcrumb-context-menu" data-agent-slug={agent.slug}>{children}</div>
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
    <div
      data-testid="session-breadcrumb-context-menu"
      data-session-id={sessionId}
      data-session-name={sessionName}
      data-agent-slug={agentSlug}
    >
      {children}
    </div>
  ),
}))

describe('AgentHeader breadcrumbs', () => {
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
})
