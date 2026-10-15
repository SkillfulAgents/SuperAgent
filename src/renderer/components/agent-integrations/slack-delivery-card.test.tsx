// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { makeChatIntegration } from './test-factories'

const state = vi.hoisted(() => ({ transport: 'direct' as 'direct' | 'relay' | null, relayAvailable: true, patches: [] as unknown[], failPatch: null as string | null }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string, options?: { method?: string; body?: string }) => {
    if (options?.method === 'PATCH') {
      state.patches.push(JSON.parse(options.body ?? '{}'))
      return state.failPatch ? Response.json({ error: state.failPatch }, { status: 400 }) : Response.json(makeChatIntegration({ provider: 'slack' }))
    }
    if (url === '/api/webhook-relay') return Response.json({ available: state.relayAvailable })
    return Response.json({ status: 'active', connected: state.transport !== null, transport: state.transport, provider: 'slack' })
  },
}))
import { SlackDeliveryCard } from './slack-delivery-card'

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const URL = 'https://relay.test/v1/hooks/whep_1'
function slack(delivery: Partial<PublicSlackDelivery> = {}) {
  return makeChatIntegration({ provider: 'slack', slack: { botTokenSaved: true, appTokenSaved: true, signingSecretSaved: false, webhook: null, ...delivery } })
}
const card = (delivery?: Partial<PublicSlackDelivery>) => render(<SlackDeliveryCard integration={slack(delivery)} />, { wrapper })

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  Object.assign(state, { transport: 'direct', relayAvailable: true, patches: [], failPatch: null })
})

describe('SlackDeliveryCard', () => {
  it('sets webhooks up on a Socket Mode app with its signing secret', async () => {
    card()
    await waitFor(() => expect(screen.getByTestId('slack-delivery-path')).toHaveTextContent('Over Socket Mode. Messages sent while it’s disconnected are missed.'))
    fireEvent.click(screen.getByRole('button', { name: 'Set up webhooks' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: ' abc123 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(state.patches).toEqual([{ settings: { webhooks: true }, config: { signingSecret: 'abc123' } }]))
  })

  it('offers webhooks only while the host has a relay', async () => {
    state.relayAvailable = false
    card()
    await waitFor(() => expect(screen.getByTestId('slack-delivery-path')).toHaveTextContent('Over Socket Mode'))
    expect(screen.queryByRole('button', { name: 'Set up webhooks' })).toBeNull()
  })

  it('shows the error when webhooks can’t be set up', async () => {
    state.failPatch = 'Webhooks are unavailable: the platform is not connected'
    card({ signingSecretSaved: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Set up webhooks' }))
    // A saved secret is enough.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Webhooks are unavailable')
    expect(state.patches).toEqual([{ settings: { webhooks: true } }])
  })

  it('guides the switch in Slack while Socket Mode keeps working', async () => {
    card({ webhook: { url: URL, status: 'pending' }, signingSecretSaved: true })
    await waitFor(() => expect(screen.getByTestId('slack-delivery-path')).toHaveTextContent('Over Socket Mode, until Slack’s first request to the webhook URL arrives.'))
    expect(screen.getByTestId('slack-webhook-url')).toHaveTextContent(URL)
    expect(screen.getByTestId('slack-webhook-waiting')).toHaveTextContent('Socket Mode keeps working until it arrives')
    expect(screen.getByTestId('slack-webhook-switch')).toHaveTextContent('turn off Enable Socket Mode')
    expect(screen.getByTestId('slack-webhook-switch')).toHaveTextContent('Interactivity & Shortcuts')
    const settings = JSON.parse(screen.getByText(/"socket_mode_enabled"/).textContent!)
    expect(settings.settings).toMatchObject({ socket_mode_enabled: false, event_subscriptions: { request_url: URL }, interactivity: { is_enabled: true, request_url: URL } })
  })

  it('asks for the signing secret again when Slack’s request doesn’t match it', async () => {
    card({ webhook: { url: URL, status: 'rejected' }, signingSecretSaved: true })
    expect(await screen.findByTestId('slack-webhook-rejected')).toHaveTextContent('doesn’t match the saved signing secret')
    expect(screen.queryByTestId('slack-webhook-waiting')).toBeNull()
    fireEvent.change(screen.getByLabelText('Signing secret'), { target: { value: 'fixed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(state.patches).toEqual([{ config: { signingSecret: 'fixed' } }]))
  })

  it('on webhooks, goes back to Socket Mode with an app-level token', async () => {
    state.transport = 'relay'
    card({ webhook: { url: URL, status: 'verified' }, signingSecretSaved: true, appTokenSaved: false })
    await waitFor(() => expect(screen.getByTestId('slack-delivery-path')).toHaveTextContent('Through webhooks.'))
    expect(screen.queryByTestId('slack-webhook-switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove webhooks' }))
    const remove = screen.getByTestId('slack-webhook-remove')
    expect(remove).toHaveTextContent('turn on Enable Socket Mode')
    const confirm = screen.getAllByRole('button', { name: 'Remove webhooks' }).at(-1)!
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('App-level token'), { target: { value: 'xapp-1' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(state.patches).toEqual([{ settings: { webhooks: false }, config: { appToken: 'xapp-1' } }]))
  })

  it('says messages wait on the relay while it is unavailable', async () => {
    Object.assign(state, { transport: null, relayAvailable: false })
    card({ webhook: { url: URL, status: 'verified' }, signingSecretSaved: true })
    await waitFor(() => expect(screen.getByTestId('slack-delivery-path')).toHaveTextContent('Not receiving: the webhook relay is unavailable.'))
  })
})
