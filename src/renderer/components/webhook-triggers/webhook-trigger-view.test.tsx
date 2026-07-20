// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WebhookTriggerView } from './webhook-trigger-view'

const capabilityUrl = 'https://hooks.example.test/private-capability'
const userState = vi.hoisted(() => ({ canAdmin: true }))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTrigger: () => ({
    data: {
      id: 'trigger-1',
      agentSlug: 'agent-1',
      kind: 'custom',
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
  useClientConfig: () => ({ data: { composioApiKeyConfigured: false } }),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: true } }),
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
