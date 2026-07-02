// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeChatIntegrations } from './home-chat-integrations'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { ChatIntegration, ChatIntegrationAccess } from '@shared/lib/db/schema'

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

const INTEGRATION: ChatIntegration = {
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
  status: 'active',
  errorMessage: null,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
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
    const integrationWithApproval: ChatIntegration = {
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

  it.each<[ChatIntegration['status'], string]>([
    ['active', 'Listening'],
    ['paused', 'Paused'],
    ['error', 'Error'],
    ['disconnected', 'Disconnected'],
  ])('renders a status tag whose label matches the Status card vocabulary (%s -> %s)', (status, label) => {
    mockUseChatIntegrations.mockReturnValue({ data: [{ ...INTEGRATION, status }] })
    renderWithProviders(<HomeChatIntegrations agentSlug="test-agent" />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
