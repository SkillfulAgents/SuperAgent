// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import type { PublicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/public'
import { makeChatIntegration } from './test-factories'
import { agentIntegrationKeys } from '@renderer/hooks/use-agent-integrations'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.request }))
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Release Assistant' } }) }))
import { LinearConnectionSettings, LinearIntegrationSettings, LinearSetupForm } from './linear-setup'
function integration(state: 'pending' | 'reconnect_needed' | 'connected' | 'setup_required'): PublicLinearIntegration {
  return { ...makeChatIntegration(), id: 'int-1', agentSlug: 'a', provider: 'linear', settings: { runOnStatusChange: false }, hasCredentials: state === 'connected',
    authorizationPendingUntil: state === 'pending' ? Date.now() + 900_000 : undefined,
    linear: {
      id: 'int-1', agentSlug: 'a', provider: 'linear', outbound: { available: false, message: null }, name: 'Helper', status: 'disconnected', errorMessage: null,
      identity: null, authorized: state === 'connected', authorizationState: state,
      authorizationMessage: state === 'reconnect_needed' ? 'Authorization expired. Start again to connect Linear.' : null,
      canReconnect: state !== 'setup_required', runOnStatusChange: false, transport: 'direct', webhook: null,
      setup: { creationUrl: 'https://linear.app/settings/api/applications/new', redirectUri: 'https://gamut.example/callback' },
    } }
}
function relayIntegration(state: 'pending' | 'reconnect_needed' | 'connected' | 'setup_required', secretSaved = false): PublicLinearIntegration {
  const base = integration(state)
  return { ...base, linear: { ...base.linear, transport: 'relay',
    webhook: { url: 'https://relay.test/v1/hooks/whep_1', resourceTypes: ['AppUserNotification', 'Comment', 'Issue'], secretSaved },
    setup: { ...base.linear.setup, creationUrl: 'https://linear.app/settings/api/applications/new?webhook.enabled=true' } } }
}
let client: QueryClient
let current: PublicLinearIntegration
let relayAvailable: boolean
let transports: string[]
let rejectAuthorization: boolean
let authorizationCount: number
const onClose = vi.fn()
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
function setupForm() { return render(<Dialog open><DialogContent><LinearSetupForm agentSlug="a" onClose={onClose} /></DialogContent></Dialog>, { wrapper }) }
function fillCredentials() {
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-id' } })
  fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'client-secret' } })
}
const creates = () => mocks.request.mock.calls.filter(([url, options]) => url === '/api/agent-integrations/agents/a' && options?.method === 'POST')
beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  current = integration('setup_required'); rejectAuthorization = false; authorizationCount = 0
  relayAvailable = false; transports = ['direct', 'relay']
  mocks.request.mockImplementation(async (url: string, options?: { body?: string }) => {
    if (url === '/api/webhook-relay') return Response.json({ available: relayAvailable, unavailableReason: relayAvailable ? null : 'platform_disconnected', transport: 'idle', lastClaimAt: null })
    if (url.includes('/providers/linear/setup?')) return Response.json({ ...integration('setup_required').linear.setup, transports })
    if (url === '/api/agent-integrations/agents/a') {
      if (JSON.parse(options?.body ?? '{}').config?.transport === 'relay') current = relayIntegration('setup_required')
      return Response.json(current)
    }
    if (url.endsWith('/authorize')) {
      authorizationCount++
      if (rejectAuthorization) return Response.json({ error: 'Authorization unavailable' }, { status: 500 })
      current = integration('pending')
      return Response.json({ url: `https://linear.app/oauth/authorize?state=attempt-${authorizationCount}` })
    }
    return Response.json(current)
  })
})

describe('Linear shared setup modal', () => {
  it('loads setup links without creating an account when opened or dismissed', async () => {
    const view = setupForm()
    expect(await screen.findByRole('link', { name: 'Create app in Linear' })).toHaveAttribute('href', current.linear.setup.creationUrl)
    expect(screen.getByTestId('integration-setup-layout')).toBeInTheDocument()
    expect(screen.getByLabelText('Integration name')).toHaveValue('Release Assistant')
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeDisabled()
    view.unmount()
    expect(creates()).toHaveLength(0)
    expect(fakeLoginWindow.prepare).not.toHaveBeenCalled()
  })
  it('keeps setup open through authorization and finishes only after the callback is observed', async () => {
    setupForm()
    await screen.findByRole('link', { name: 'Create app in Linear' })
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    expect(fakeLoginWindow.prepare).toHaveBeenCalledOnce()
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith(expect.stringContaining('state=attempt-1')))
    expect(creates()).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for authorization')
    expect(screen.getByLabelText('Client secret')).toHaveValue('')
    expect(onClose).not.toHaveBeenCalled()
    current = integration('connected')
    await client.invalidateQueries({ queryKey: agentIntegrationKeys.detail('int-1') })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(fakeLoginWindow.close).toHaveBeenCalled()
  })
  it('retries failed authorization on the same installation', async () => {
    rejectAuthorization = true
    setupForm()
    await screen.findByRole('link', { name: 'Create app in Linear' })
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Authorization unavailable')
    rejectAuthorization = false
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalled())
    expect(creates()).toHaveLength(1)
    expect(authorizationCount).toBe(2)
  })
  it('keeps cancellation in the modal and retries with saved credentials', async () => {
    setupForm()
    await screen.findByRole('link', { name: 'Create app in Linear' })
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalled())
    current = integration('reconnect_needed')
    await client.invalidateQueries({ queryKey: agentIntegrationKeys.detail('int-1') })
    expect(await screen.findByRole('alert')).toHaveTextContent('Authorization expired')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Open Linear again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))
    await waitFor(() => expect(authorizationCount).toBe(2))
    const calls = mocks.request.mock.calls.filter(([url]) => url.endsWith('/authorize'))
    expect(JSON.parse(calls[1][1].body)).toEqual({})
    expect(creates()).toHaveLength(1)
  })
})

describe('Linear authorization recovery', () => {
  it('retries with saved credentials, replaces the link, and drops expired links', async () => {
    const view = render(<LinearConnectionSettings integration={integration('reconnect_needed')} />, { wrapper })
    expect(screen.getByRole('alert')).toHaveTextContent('Authorization expired')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect account' }))
    await waitFor(() => expect(authorizationCount).toBe(1))
    expect(JSON.parse(mocks.request.mock.calls.find(([url]) => url.endsWith('/authorize'))![1].body)).toEqual({})
    view.rerender(<LinearConnectionSettings integration={integration('pending')} />)
    expect(await screen.findByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', expect.stringContaining('state=attempt-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', expect.stringContaining('state=attempt-2')))
    view.rerender(<LinearConnectionSettings integration={integration('reconnect_needed')} />)
    expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reconnect account' })).toBeEnabled()
  })
  it('allows credential correction after a failed attempt', async () => {
    render(<LinearConnectionSettings integration={integration('reconnect_needed')} />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Edit app credentials' }))
    fillCredentials()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to authorization' }))
    await waitFor(() => expect(authorizationCount).toBe(1))
    expect(JSON.parse(mocks.request.mock.calls.find(([url]) => url.endsWith('/authorize'))![1].body)).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' })
  })
  it('can restart pending authorization after reloading the page', async () => {
    render(<LinearConnectionSettings integration={integration('pending')} />, { wrapper })
    expect(screen.queryByRole('link', { name: 'Authorize in Linear' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    expect(await screen.findByRole('link', { name: 'Authorize in Linear' })).toHaveAttribute('href', expect.stringContaining('state=attempt-1'))
  })
})

describe('Linear over the webhook relay', () => {
  it('defaults to webhooks, creates the webhook URL before the app, and sends the signing secret', async () => {
    relayAvailable = true
    setupForm()
    const getUrl = await screen.findByRole('button', { name: 'Get webhook URL' })
    expect(screen.getByRole('radio', { name: /Through webhooks/ })).toBeChecked()
    expect(screen.queryByRole('link', { name: 'Create app in Linear' })).toBeNull()

    fireEvent.click(getUrl)
    expect(await screen.findByRole('link', { name: 'Create app in Linear' })).toHaveAttribute('href', expect.stringContaining('webhook.enabled=true'))
    expect(JSON.parse(creates()[0][1].body)).toMatchObject({ config: { transport: 'relay' } })
    // Fixed once the account exists.
    expect(screen.queryByRole('radio')).toBeNull()

    fillCredentials()
    expect(screen.getByRole('button', { name: /^Connect$/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Webhook signing secret'), { target: { value: 'lin_wh_secret' } })
    fireEvent.click(screen.getByRole('button', { name: /^Connect$/ }))

    await waitFor(() => expect(authorizationCount).toBe(1))
    const authorize = mocks.request.mock.calls.find(([url]) => url.endsWith('/authorize'))!
    expect(JSON.parse(authorize[1].body)).toEqual({ clientId: 'client-id', clientSecret: 'client-secret', webhookSecret: 'lin_wh_secret' })
    expect(creates()).toHaveLength(1)
  })

  it('offers only the live connection while the relay is unavailable', async () => {
    setupForm()
    await screen.findByRole('link', { name: 'Create app in Linear' })
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByLabelText('Webhook signing secret')).toBeNull()
  })

  it('shows the webhook URL, asks for a missing secret, and saves it', async () => {
    relayAvailable = true
    render(<LinearIntegrationSettings integration={relayIntegration('connected')} />, { wrapper })
    expect(screen.getByTestId('linear-webhook-url')).toHaveTextContent('https://relay.test/v1/hooks/whep_1')
    expect(screen.getByText(/Inbox notifications, Comments, Issues/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Paste the app’s webhook signing secret')

    fireEvent.change(screen.getByLabelText('Webhook signing secret'), { target: { value: ' lin_wh_secret ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/api/agent-integrations/int-1', expect.objectContaining({ method: 'PATCH' })))
    const patch = mocks.request.mock.calls.find(([, options]) => options?.method === 'PATCH')!
    expect(JSON.parse(patch[1].body)).toEqual({ settings: { webhookSecret: 'lin_wh_secret' } })
  })

  it('switches transports only on request, and only to a relay that is available', async () => {
    const { unmount } = render(<LinearIntegrationSettings integration={integration('connected')} />, { wrapper })
    await waitFor(() => expect(mocks.request.mock.calls.some(([url]) => url === '/api/webhook-relay')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Switch to webhooks' })).toBeNull()
    unmount()

    relayAvailable = true
    client.clear()
    render(<LinearIntegrationSettings integration={integration('connected')} />, { wrapper })
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to webhooks' }))
    await waitFor(() => {
      const patch = mocks.request.mock.calls.find(([, options]) => options?.method === 'PATCH')
      expect(JSON.parse(patch![1].body)).toEqual({ settings: { transport: 'relay' } })
    })
  })
})
