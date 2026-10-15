// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import type { PublicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { makeChatIntegration } from './test-factories'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const state = vi.hoisted(() => ({ relayAvailable: true, requests: [] as Array<{ url: string; method: string; body: any }> }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET'
    if (method !== 'GET') state.requests.push({ url, method, body: JSON.parse(options?.body ?? '{}') })
    if (url === '/api/webhook-relay') return Response.json({ available: state.relayAvailable })
    if (url === '/api/agent-integrations/agents/a' && method === 'POST') {
      return Response.json(makeChatIntegration({ id: 'int-9', provider: 'slack', status: 'disconnected', hasCredentials: false,
        slack: { botTokenSaved: false, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } } }), { status: 201 })
    }
    return Response.json(makeChatIntegration({ provider: 'slack' }))
  },
}))
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
import { SlackConnectionSettings, SlackSetup } from './slack-setup'

let client: QueryClient
const onClose = vi.fn()
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const setup = () => render(<Dialog open><DialogContent><SlackSetup agentSlug="a" onClose={onClose} /></DialogContent></Dialog>, { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  Object.assign(state, { relayAvailable: true, requests: [] })
})

describe('SlackSetup', () => {
  it('with a relay, creates the installation first and opens Slack with the webhook URL in the manifest', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText('Integration name'), { target: { value: 'Helper' } })
    expect(screen.queryByLabelText('App-Level Token')).toBeNull()
    expect(screen.getByLabelText('Bot Token')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()

    fireEvent.click(screen.getByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    expect(state.requests[0]).toEqual({ url: '/api/agent-integrations/agents/a', method: 'POST', body: expect.objectContaining({ provider: 'slack', name: 'Helper', config: { webhooks: true, onlyMentioned: true } }) })
    const opened = new URL(fakeLoginWindow.navigate.mock.calls[0][0])
    expect(opened.origin + opened.pathname).toBe('https://api.slack.com/apps')
    expect(JSON.parse(opened.searchParams.get('manifest_json')!)).toMatchObject({
      display_information: { name: 'Helper' },
      settings: { socket_mode_enabled: false, event_subscriptions: { request_url: 'https://relay.test/v1/hooks/whep_1' }, interactivity: { request_url: 'https://relay.test/v1/hooks/whep_1' } },
    })
    // The choice is fixed once the installation exists.
    expect(screen.getByTestId('slack-webhooks-choice')).toBeDisabled()
    expect(screen.getByLabelText('Integration name')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Signing Secret'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(state.requests[1]).toEqual({ url: '/api/agent-integrations/int-9', method: 'PATCH', body: { status: 'active', showToolCalls: false, sessionTimeout: null, config: { botToken: 'xoxb-1', signingSecret: 'secret', onlyMentioned: true, answerInThread: false, newSessionPerThread: false } } })
  })

  it('uses Socket Mode without a relay, or when webhooks are turned off', async () => {
    state.relayAvailable = false
    const view = setup()
    expect(await screen.findByLabelText('App-Level Token')).toBeInTheDocument()
    expect(screen.queryByTestId('slack-webhooks-choice')).toBeNull()
    view.unmount()

    state.relayAvailable = true
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    setup()
    fireEvent.click(await screen.findByTestId('slack-webhooks-choice'))
    expect(await screen.findByLabelText('App-Level Token')).toBeInTheDocument()
    expect(screen.getByTestId('slack-webhooks-choice')).not.toBeChecked()
  })
})

describe('SlackConnectionSettings', () => {
  const integration = (delivery: Partial<PublicSlackDelivery>) => makeChatIntegration({ id: 'int-9', name: 'Helper', provider: 'slack',
    slack: { botTokenSaved: false, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' }, ...delivery } })

  it('finishes an installation whose app setup stopped partway', async () => {
    render(<SlackConnectionSettings integration={integration({})} />, { wrapper })
    expect(screen.getByRole('link', { name: 'Create app in Slack' }).getAttribute('href')).toContain('manifest_json=')
    fireEvent.change(screen.getByLabelText('Signing Secret'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(state.requests).toEqual([{ url: '/api/agent-integrations/int-9', method: 'PATCH', body: { status: 'active', config: { botToken: 'xoxb-1', signingSecret: 'secret' } } }]))
  })

  it('shows nothing once the app is connected', () => {
    const { container } = render(<SlackConnectionSettings integration={integration({ botTokenSaved: true })} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })
})
