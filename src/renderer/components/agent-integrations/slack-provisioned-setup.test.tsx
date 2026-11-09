// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { makeChatIntegration } from './test-factories'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const AGENT = { slug: 'a', name: 'Infra Agent', description: 'Keeps the servers up', avatar: null }
const state = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; body: any }>,
  provisioning: true as boolean,
  installed: false,
}))
const pending = () => makeChatIntegration({
  id: 'int-9', provider: 'slack', status: state.installed ? 'active' : 'disconnected', hasCredentials: state.installed,
  slack: { botTokenSaved: state.installed, appTokenSaved: false, signingSecretSaved: true, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } },
  provisionedApp: { directoryId: 'dir-1', installed: state.installed, name: 'Infra Agent', iconSet: false },
})
vi.mock('@renderer/lib/api', () => {
  const apiFetch = async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET'
    if (method !== 'GET') state.requests.push({ url, method, body: JSON.parse(options?.body ?? '{}') })
    if (url === '/api/webhook-relay') return Response.json({ available: true })
    if (url === '/api/agents/a') return Response.json(AGENT)
    if (url.startsWith('/api/agent-integrations/agents/a/providers/slack/setup')) {
      return Response.json(state.provisioning ? { transports: ['relay', 'direct'], provisioning: { directoryId: 'dir-1', workspace: 'Acme' } } : { transports: ['relay', 'direct'] })
    }
    if (url === '/api/agent-integrations/agents/a' && method === 'POST') return Response.json(pending(), { status: 201 })
    if (url === '/api/agent-integrations/int-9/authorize') return Response.json({ url: 'https://slack.com/oauth/v2/authorize?client_id=1&state=s' })
    if (url === '/api/agent-integrations/int-9') return Response.json(pending())
    return Response.json(makeChatIntegration({ provider: 'slack' }))
  }
  return { apiFetch, apiJson: async (url: string) => (await apiFetch(url)).json() }
})
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
import { SlackSetup } from './slack-setup'

let client: QueryClient
const onClose = vi.fn()
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const setup = () => render(<Dialog open><DialogContent><SlackSetup agentSlug="a" onClose={onClose} /></DialogContent></Dialog>, { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  Object.assign(state, { requests: [], provisioning: true, installed: false })
})

describe('Slack setup through a team directory', () => {
  it('creates the agent’s app, then installs it with one click', async () => {
    setup()
    expect(await screen.findByTestId('slack-provisioned-setup')).toHaveTextContent('Create this agent’s Slack app in Acme')
    expect(screen.getByTestId('slack-provisioned-install')).toBeDisabled()

    await waitFor(() => expect(screen.getByTestId('slack-provisioned-create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('slack-provisioned-create'))
    await waitFor(() => expect(screen.getByTestId('slack-provisioned-created')).toHaveTextContent('App created in Acme'))
    expect(state.requests[0]).toEqual({ url: '/api/agent-integrations/agents/a', method: 'POST', body: expect.objectContaining({
      provider: 'slack',
      config: expect.objectContaining({ webhooks: true, provision: { directoryId: 'dir-1', name: 'Infra Agent', description: 'Keeps the servers up' } }),
    }) })

    await waitFor(() => expect(screen.getByTestId('slack-provisioned-install')).toBeEnabled())
    fireEvent.click(screen.getByTestId('slack-provisioned-install'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?client_id=1&state=s'))
    expect(state.requests.at(-1)).toMatchObject({ url: '/api/agent-integrations/int-9/authorize', method: 'POST' })

    // The install lands in the other window; the dialog closes when the integration reports it.
    state.installed = true
    await client.invalidateQueries()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('keeps the manual setup a click away', async () => {
    setup()
    fireEvent.click(await screen.findByTestId('slack-setup-manually'))
    expect(await screen.findByTestId('slack-create-app')).toBeInTheDocument()
  })

  it('is the manual setup when no directory can create apps', async () => {
    state.provisioning = false
    setup()
    expect(await screen.findByTestId('slack-create-app')).toBeInTheDocument()
    expect(screen.queryByTestId('slack-provisioned-setup')).toBeNull()
  })
})
