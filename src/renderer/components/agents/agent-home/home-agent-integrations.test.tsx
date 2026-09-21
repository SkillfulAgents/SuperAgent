// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeAgentIntegrations } from './home-agent-integrations'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ChatIntegration, ChatIntegrationAccess } from '@shared/lib/db/schema'

// The list route enriches each row with the live transport state.
type ListItem = ChatIntegration & { connected: boolean }

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUseChatIntegrations = vi.fn()
const mockUseChatIntegrationAccess = vi.fn()

vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useAgentIntegrations: (...args: unknown[]) => mockUseChatIntegrations(...args),
  useAgentIntegrationAccess: (...args: unknown[]) => mockUseChatIntegrationAccess(...args),
}))

const mockCanManage = vi.fn(() => true)
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canAdminAgent: () => mockCanManage(),
    canUseAgent: () => mockCanManage(),
  }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/agent-integrations/agent-integration-setup-dialog', () => ({
  AgentIntegrationSetupDialog: () => null,
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2025-01-01')

const INTEGRATION: ListItem = {
  id: 'int-1',
  agentSlug: 'test-agent',
  provider: 'telegram',
  name: 'Test Bot',
  config: '{}',
  showToolCalls: false,
  requireApproval: false,
  sessionTimeout: null,
  model: null,
  connectionId: null,
  effort: null,
  speed: null,
  status: 'active',
  errorMessage: null,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  connected: true,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HomeAgentIntegrations', () => {
  it('puts Linear and chat providers in the same list with the same navigation', async () => {
    mockUseChatIntegrations.mockReturnValue({ data: [INTEGRATION, { ...INTEGRATION, id: 'linear-1', name: 'Linear Agent', provider: 'linear' }] })
    renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)
    expect(screen.getByText('External Integrations')).toBeInTheDocument()
    expect(screen.getByText('Test Bot')).toBeInTheDocument()
    expect(screen.queryByText('Task Platforms')).toBeNull()
    await userEvent.setup().click(screen.getByText('Linear Agent'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents/$slug/chat/$integrationId', params: { slug: 'test-agent', integrationId: 'linear-1' } })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockCanManage.mockReturnValue(true)
    mockUseChatIntegrations.mockReturnValue({ data: [INTEGRATION] })
    mockUseChatIntegrationAccess.mockReturnValue({ data: [] })
  })

  it('shows reconnect needed on the shared home card', () => {
    mockUseChatIntegrations.mockReturnValue({ data: [{ ...INTEGRATION, provider: 'linear', status: 'disconnected', connected: false, reconnectRequired: true }] })
    renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)
    expect(screen.getByText('Reconnect needed')).toBeInTheDocument()
  })

  it('does NOT render a per-row settings/actions kebab', () => {
    renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)
    expect(screen.queryByLabelText(/actions for/i)).not.toBeInTheDocument()
  })

  it('navigates to the chat route when a row is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)

    await user.click(screen.getByText('Test Bot'))

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug/chat/$integrationId',
      params: { slug: 'test-agent', integrationId: 'int-1' },
    })
  })

  it('shows "N pending" badge when there are pending access requests', async () => {
    const integrationWithApproval: ListItem = {
      ...INTEGRATION,
      requireApproval: true,
    }
    const pendingAccess: ChatIntegrationAccess = {
      id: 'acc-1',
      integrationId: 'int-1',
      externalChatId: 'chat-1',
      chatType: 'private',
      status: 'pending',
      approvalSource: null,
      title: null,
      firstUserId: null,
      firstUserName: null,
      firstMessagePreview: null,
      requestNoticeSentAt: null,
      requestedAt: NOW,
      decidedAt: null,
      decidedByUserId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }

    mockUseChatIntegrations.mockReturnValue({ data: [integrationWithApproval] })
    mockUseChatIntegrationAccess.mockReturnValue({ data: [pendingAccess] })

    renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)

    expect(await screen.findByText('1 pending')).toBeInTheDocument()
  })

  // Same derivation (and vocabulary) as the connector page's Status card: the tag
  // reads the live `connected` the list carries, so "active" splits into
  // "Listening" (wire up) vs "Connecting…" (wire not up yet) instead of always
  // claiming "Listening" from persisted status alone.
  it.each<[ChatIntegration['status'], boolean, string]>([
    ['active', true, 'Listening'],
    ['active', false, 'Connecting…'],
    ['paused', false, 'Paused'],
    ['error', false, 'Error'],
  ])('renders the status tag from (status=%s, connected=%s) -> %s', (status, connected, label) => {
    mockUseChatIntegrations.mockReturnValue({ data: [{ ...INTEGRATION, status, connected }] })
    renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

it('does not invite viewers to configure providers or render an empty setup grid', () => {
  mockCanManage.mockReturnValue(false)
  mockUseChatIntegrations.mockReturnValue({ data: [] })
  const { container } = renderWithProviders(<HomeAgentIntegrations agentSlug="test-agent" />)
  expect(screen.getByText('No external integrations have been configured for this agent.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /connect via/i })).not.toBeInTheDocument()
  expect(container.querySelector('.grid')).toBeNull()
})
