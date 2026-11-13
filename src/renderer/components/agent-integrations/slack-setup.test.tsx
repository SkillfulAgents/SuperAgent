// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import type { PublicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { makeChatIntegration } from './test-factories'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const AGENT = { slug: 'a', name: 'Infra Agent', description: 'Keeps the servers up', avatar: { color: 'tonal-amber', shape: 'circle' } }
const state = vi.hoisted(() => ({ relayAvailable: true, requests: [] as Array<{ url: string; method: string; body: any }>, agent: null as unknown }))
vi.mock('@renderer/lib/api', () => {
  const apiFetch = async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET'
    if (method !== 'GET') state.requests.push({ url, method, body: JSON.parse(options?.body ?? '{}') })
    if (url === '/api/webhook-relay') return Response.json({ available: state.relayAvailable })
    if (url === '/api/agents/a') return Response.json(state.agent)
    if (url === '/api/agent-integrations/agents/a' && method === 'POST') {
      return Response.json(makeChatIntegration({ id: 'int-9', provider: 'slack', status: 'disconnected', hasCredentials: false,
        slack: { botTokenSaved: false, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: 'pending' } } }), { status: 201 })
    }
    return Response.json(makeChatIntegration({ provider: 'slack' }))
  }
  return { apiFetch, apiJson: async (url: string) => (await apiFetch(url)).json() }
})
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
import { SlackConnectionSettings, SlackSetup } from './slack-setup'
import { slackBackgroundColor } from './slack-app-identity'
import { SlackAppAppearanceCard } from './slack-app-appearance'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'

let client: QueryClient
const onClose = vi.fn()
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const setup = () => render(<Dialog open><DialogContent><SlackSetup agentSlug="a" onClose={onClose} /></DialogContent></Dialog>, { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  Object.assign(state, { relayAvailable: true, requests: [], agent: AGENT })
})

describe('SlackSetup', () => {
  it('sends an explicit off for threading turned off at setup, so the server default does not turn it back on', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText('Add-on name'), { target: { value: 'Helper' } })
    fireEvent.click(screen.getByRole('switch', { name: /Reply in thread/ }))
    fireEvent.click(screen.getByTestId('slack-create-app'))
    await waitFor(() => expect(state.requests[0]).toBeDefined())
    expect(state.requests[0].body.config).toMatchObject({ answerInThread: false, newSessionPerThread: false })
  })

  it('with a relay, creates the installation first and opens Slack with the webhook URL in the manifest', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText('Add-on name'), { target: { value: 'Helper' } })
    expect(screen.queryByLabelText('App-Level Token')).toBeNull()
    expect(screen.getByLabelText('Bot Token')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()

    fireEvent.click(screen.getByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    expect(state.requests[0]).toEqual({ url: '/api/agent-integrations/agents/a', method: 'POST', body: expect.objectContaining({ provider: 'slack', name: 'Helper', config: { webhooks: true, onlyMentioned: true, answerInThread: true, newSessionPerThread: true } }) })
    const opened = new URL(fakeLoginWindow.navigate.mock.calls[0][0])
    expect(opened.origin + opened.pathname).toBe('https://api.slack.com/apps')
    expect(JSON.parse(opened.searchParams.get('manifest_json')!)).toMatchObject({
      display_information: { name: 'Helper' },
      settings: { socket_mode_enabled: false, event_subscriptions: { request_url: 'https://relay.test/v1/hooks/whep_1' }, interactivity: { request_url: 'https://relay.test/v1/hooks/whep_1' } },
    })
    // The choice is fixed once the installation exists.
    expect(screen.getByTestId('slack-webhooks-choice')).toBeDisabled()
    expect(screen.getByLabelText('Add-on name')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Signing Secret'), { target: { value: 'secret' } })
    fireEvent.change(screen.getByLabelText('Bot Token'), { target: { value: 'xoxb-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(state.requests[1]).toEqual({ url: '/api/agent-integrations/int-9', method: 'PATCH', body: { status: 'active', showToolCalls: false, sessionTimeout: 6, config: { botToken: 'xoxb-1', signingSecret: 'secret', onlyMentioned: true, answerInThread: true, newSessionPerThread: true } } })
  })

  it('names the Slack app and its bot after the agent, in its colour, and offers its icon', async () => {
    setup()
    await screen.findByPlaceholderText('Infra Agent')
    expect(screen.getByTestId('slack-app-icon-download')).toHaveTextContent('Download icon')
    fireEvent.click(screen.getByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    expect(state.requests[0].body.name).toBeUndefined()
    const manifest = JSON.parse(new URL(fakeLoginWindow.navigate.mock.calls[0][0]).searchParams.get('manifest_json')!)
    expect(manifest.display_information).toEqual({ name: 'Infra Agent', description: 'Keeps the servers up', background_color: slackBackgroundColor(avatarSource(AGENT.avatar as AgentAvatar).orb) })
    expect(manifest.features.bot_user.display_name).toBe('Infra Agent')
  })

  it('falls back to Gamut Bot, with no colour or icon, for an agent without an avatar', async () => {
    state.agent = { slug: 'a', name: '', avatar: null }
    setup()
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    const manifest = JSON.parse(new URL(fakeLoginWindow.navigate.mock.calls[0][0]).searchParams.get('manifest_json')!)
    expect(manifest.display_information).toEqual({ name: 'Gamut Bot' })
    expect(screen.queryByTestId('slack-app-icon-download')).toBeNull()
  })

  it('keeps a created installation’s form while the relay goes away and comes back', async () => {
    setup()
    fireEvent.click(await screen.findByTestId('slack-create-app'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByLabelText('Signing Secret'), { target: { value: 'secret' } })
    state.relayAvailable = false
    await client.invalidateQueries({ queryKey: ['webhook-relay'] })
    await waitFor(() => expect(screen.queryByTestId('slack-webhooks-choice')).toBeNull())
    expect(screen.queryByLabelText('App-Level Token')).toBeNull()
    expect(screen.getByLabelText('Signing Secret')).toHaveValue('secret')
    state.relayAvailable = true
    await client.invalidateQueries({ queryKey: ['webhook-relay'] })
    await screen.findByTestId('slack-webhooks-choice')
    // The Slack app already targets the first installation's URL.
    expect(screen.getByTestId('slack-setup-webhook-url')).toHaveTextContent('https://relay.test/v1/hooks/whep_1')
    expect(screen.getByLabelText('Signing Secret')).toHaveValue('secret')
    expect(screen.getByLabelText('Bot Token')).toBeEnabled()
    expect(state.requests.filter(request => request.method === 'POST')).toHaveLength(1)
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

describe('SlackAppAppearanceCard', () => {
  const integration = (botTokenSaved: boolean) => makeChatIntegration({ provider: 'slack',
    slack: { botTokenSaved, appTokenSaved: false, signingSecretSaved: false, webhook: { url: 'https://relay.test/v1/hooks/whep_1', status: botTokenSaved ? 'verified' : 'pending' } } })

  it('offers a connected app the agent’s icon and colour', async () => {
    render(<SlackAppAppearanceCard integration={integration(true)} />, { wrapper })
    expect(await screen.findByTestId('slack-app-icon-download')).toBeInTheDocument()
    expect(screen.getByTestId('slack-app-appearance')).toHaveTextContent(slackBackgroundColor(avatarSource(AGENT.avatar as AgentAvatar).orb))
  })

  it('leaves an app still being set up to its setup steps', async () => {
    const { container } = render(<SlackAppAppearanceCard integration={integration(false)} />, { wrapper })
    await waitFor(() => expect(client.getQueryData(['agents', 'a'])).toBeTruthy())
    expect(container).toBeEmptyDOMElement()
  })
})
