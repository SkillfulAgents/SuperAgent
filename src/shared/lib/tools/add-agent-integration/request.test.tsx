// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders as render } from '@renderer/test/test-utils'
import { IntegrationSetupRequestItem } from './request'

const mockApiFetch = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

let isOwner = true
vi.mock('@renderer/context/user-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/context/user-context')>(),
  useUser: () => ({ canAdminAgent: () => isOwner }),
}))

// The provider forms have tests of their own; this card only chooses and seeds one.
vi.mock('@renderer/components/agent-integrations/agent-integration-setup-dialog', () => ({
  AgentIntegrationSetupDialog: ({ provider, initial }: { provider: { slug: string } | null; initial?: unknown }) =>
    provider ? <div data-testid="setup-dialog">{provider.slug} {JSON.stringify(initial)}</div> : null,
}))

const props = {
  toolUseId: 'tu-setup',
  provider: 'platform-email',
  reason: 'So customers can email support requests to me',
  prefill: { name: 'Support Desk', localPart: 'support' },
  sessionId: 's-1',
  agentSlug: 'my-agent',
  onComplete: vi.fn(),
}

describe('IntegrationSetupRequestItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner = true
  })

  it('opens the provider setup with the agent\'s suggestions for the owner', async () => {
    render(<IntegrationSetupRequestItem {...props} />)
    expect(screen.getByText('Set up Email for this agent?')).toBeInTheDocument()
    expect(screen.getByText('So customers can email support requests to me')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('integration-setup-open-btn'))

    expect(screen.getByTestId('setup-dialog')).toHaveTextContent('platform-email {"name":"Support Desk","localPart":"support"}')
    expect(props.onComplete).not.toHaveBeenCalled()
  })

  it('tells anyone else that only the owner can set it up', () => {
    isOwner = false
    render(<IntegrationSetupRequestItem {...props} />)
    expect(screen.queryByTestId('integration-setup-open-btn')).not.toBeInTheDocument()
    expect(screen.getByText(/Only the agent's owner can set up Email/)).toBeInTheDocument()
    expect(screen.getByTestId('integration-setup-decline-btn')).toBeEnabled()
  })

  it('declines through the session route', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) })
    render(<IntegrationSetupRequestItem {...props} />)

    await userEvent.click(screen.getByTestId('integration-setup-decline-btn'))

    await waitFor(() => expect(props.onComplete).toHaveBeenCalledOnce())
    const [url, init] = mockApiFetch.mock.calls[0]
    expect(url).toBe('/api/agents/my-agent/sessions/s-1/decline-integration-setup')
    expect(JSON.parse(init.body)).toEqual({ toolUseId: 'tu-setup' })
  })
})
