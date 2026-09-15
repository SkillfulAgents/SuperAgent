// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HomeTaskIntegrations } from './home-task-integrations'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), admin: true }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.fetch }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Helper' } }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canAdminAgent: () => mocks.admin }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
const integration = { id: 'installation', agentSlug: 'agent', provider: 'linear', name: 'Helper', status: 'disconnected', authorized: false, identity: null, runOnStatusChange: false,
  setup: { creationUrl: 'https://linear.app/settings/api/applications/new?distribution=private', webhookUrl: 'https://relay.example/hooks/test', redirectUri: 'http://localhost/callback' } }
beforeEach(() => { vi.clearAllMocks(); mocks.admin = true })
describe('Linear setup UI', () => {
  it('opens the credentials form and follows authorization without a render error', async () => {
    const user = userEvent.setup()
    let created = false
    mocks.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/linear')) { created = true; return Response.json(integration, { status: 201 }) }
      if (url.endsWith('/authorize')) return Response.json({ url: 'https://linear.app/oauth/authorize?actor=app' })
      if (url.endsWith('/sessions')) return Response.json([])
      return Response.json(created ? [integration] : [])
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><HomeTaskIntegrations agentSlug="agent" /></QueryClientProvider>)
    await user.click(await screen.findByRole('button', { name: 'Add Linear' }))
    await user.click(screen.getByRole('button', { name: 'Set up Linear' }))
    expect(await screen.findByRole('link', { name: 'Create app in Linear' })).toHaveAttribute('href', integration.setup.creationUrl)
    await user.type(screen.getByLabelText('Client ID'), 'client')
    await user.type(screen.getByLabelText('Client secret'), 'client-secret')
    await user.type(screen.getByLabelText('Webhook signing secret'), 'webhook-secret')
    await user.click(screen.getByRole('button', { name: 'Continue to authorization' }))
    expect(await screen.findByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', 'https://linear.app/oauth/authorize?actor=app')
    await waitFor(() => expect(screen.getByLabelText('Client secret')).toHaveValue(''))
    queryClient.clear()
  })
  it('does not expose setup controls to viewers', async () => {
    mocks.admin = false
    mocks.fetch.mockResolvedValue(Response.json([]))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><HomeTaskIntegrations agentSlug="agent" /></QueryClientProvider>)
    expect(screen.queryByRole('button', { name: 'Add Linear' })).not.toBeInTheDocument()
    queryClient.clear()
  })
})
