// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeChatIntegrations } from './home-chat-integrations'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ChatIntegration, ChatIntegrationAccess } from '@shared/lib/db/schema'

// The list route enriches each row with the live transport state.
type ListItem = ChatIntegration & { connected: boolean }

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUseChatIntegrations = vi.fn()
const mockUseChatIntegrationAccess = vi.fn()

vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useChatIntegrations: (...args: unknown[]) => mockUseChatIntegrations(...args),
  useChatIntegrationAccess: (...args: unknown[]) => mockUseChatIntegrationAccess(...args),
}))

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canAdminAgent: () => true,
    canUseAgent: () => true,
  }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/components/chat-integrations/chat-integration-setup-dialog', () => ({
  ChatIntegrationSetupDialog: () => null,
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

describe('HomeChatIntegrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseChatIntegrations.mockReturnValue({ data: [INTEGRATION] })
    mockUseChatIntegrationAccess.mockReturnValue({ data: [] })
  })

  it('does NOT render a per-row settings/actions kebab', () => {
    renderWithProviders(<HomeChatIntegrations agentSlug="test-agent" />)
    expect(screen.queryByLabelText(/actions for/i)).not.toBeInTheDocument()
  })

  it('navigates to the chat route when a row is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<HomeChatIntegrations agentSlug="test-agent" />)

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

    renderWithProviders(<HomeChatIntegrations agentSlug="test-agent" />)

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
    renderWithProviders(<HomeChatIntegrations agentSlug="test-agent" />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
