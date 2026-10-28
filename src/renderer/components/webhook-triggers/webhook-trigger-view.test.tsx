// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WebhookTriggerView } from './webhook-trigger-view'

const capabilityUrl = 'https://hooks.example.test/private-capability'
const userState = vi.hoisted(() => ({ canAdmin: true }))
const relayState = vi.hoisted(() => ({
  status: { available: true, unavailableReason: null, transport: 'realtime', lastClaimAt: null } as Record<string, unknown>,
  kind: 'custom',
  personalComposioKey: false,
}))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTrigger: () => ({
    data: {
      id: 'trigger-1',
      agentSlug: 'agent-1',
      kind: relayState.kind,
      triggerType: 'CUSTOM_WEBHOOK',
      triggerConfig: JSON.stringify({ url: 'https://hooks.example.test/private-capability' }),
      prompt: 'Handle the event',
      name: 'Inbound events',
      status: 'active',
      fireCount: 0,
      lastFiredAt: null,
      model: null,
      effort: null,
      speed: null,
      createdAt: new Date('2026-07-17T00:00:00Z'),
    },
    isLoading: false,
    error: null,
  }),
  useWebhookTriggerSessions: () => ({ data: [] }),
  useCancelWebhookTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePauseWebhookTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeWebhookTrigger: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateWebhookTriggerPrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateWebhookTriggerRuntimeOptions: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    canUseAgent: () => true,
    canAdminAgent: () => userState.canAdmin,
  }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [{ slug: 'agent-1' }] }),
  resolveRouteAgentId: (slug: string) => slug,
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({
    data: { apiKeyStatus: { composio: { isConfigured: relayState.personalComposioKey } } },
  }),
  useModelSettings: () => ({ data: undefined }),
}))

vi.mock('@renderer/hooks/use-webhook-relay', () => ({
  useWebhookRelay: () => ({ data: relayState.status }),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@renderer/components/layout/settings-page', () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

vi.mock('@renderer/components/triggers/detail-card', () => ({
  DetailCard: ({ label, children }: { label: string; children: ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
}))

vi.mock('@renderer/components/triggers/status-toggle', () => ({ StatusToggle: () => null }))
vi.mock('@renderer/components/triggers/run-history-section', () => ({ RunHistorySection: () => null }))
vi.mock('@renderer/components/triggers/collapsible-prompt-text', () => ({
  CollapsiblePromptText: ({ text }: { text: string }) => <span>{text}</span>,
}))
vi.mock('@renderer/components/triggers/edit-prompt-dialog', () => ({ EditPromptDialog: () => null }))
vi.mock('@renderer/components/triggers/runtime-options-card', () => ({ RuntimeOptionsCard: () => null }))

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}))

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: () => null,
  AlertDialogAction: () => null,
  AlertDialogCancel: () => null,
  AlertDialogContent: () => null,
  AlertDialogDescription: () => null,
  AlertDialogFooter: () => null,
  AlertDialogHeader: () => null,
  AlertDialogTitle: () => null,
}))

afterEach(() => {
  userState.canAdmin = true
  relayState.status = { available: true, unavailableReason: null, transport: 'realtime', lastClaimAt: null }
  relayState.kind = 'custom'
  relayState.personalComposioKey = false
})

describe('WebhookTriggerView owner-only details', () => {
  it('does not render a capability URL for a non-owner even if stale data contains it', () => {
    userState.canAdmin = false

    render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)

    expect(screen.queryByText('Endpoint URL')).not.toBeInTheDocument()
    expect(screen.queryByText(capabilityUrl)).not.toBeInTheDocument()
  })

  it('renders the capability URL for an owner', () => {
    render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)

    expect(screen.getByText('Endpoint URL')).toBeInTheDocument()
    expect(screen.getByText(capabilityUrl)).toBeInTheDocument()
  })
})

describe('WebhookTriggerView relay notices', () => {
  it('says nothing while the relay is receiving', () => {
    render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)

    expect(screen.queryByTestId('webhook-relay-notice')).not.toBeInTheDocument()
  })

  it('asks for a platform connection when the relay is unavailable for that reason', () => {
    relayState.status = { available: false, unavailableReason: 'platform_disconnected', transport: 'idle', lastClaimAt: null }

    render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)

    expect(screen.getByTestId('webhook-relay-notice')).toHaveTextContent('require a platform connection')
  })

  it('says claiming is failing while the relay is unreachable', () => {
    relayState.status = { available: true, unavailableReason: null, transport: 'unreachable', lastClaimAt: null }

    render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)

    expect(screen.getByTestId('webhook-relay-notice')).toHaveTextContent('Claiming webhook events from the relay is failing')
  })

  it('warns about a personal Composio key only on Composio triggers', () => {
    relayState.personalComposioKey = true

    const { unmount } = render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)
    expect(screen.queryByText(/personal Composio API key/)).not.toBeInTheDocument()
    unmount()

    relayState.kind = 'composio'
    render(<WebhookTriggerView triggerId="trigger-1" agentSlug="agent-1" />)
    expect(screen.getByText(/personal Composio API key/)).toBeInTheDocument()
  })
})
