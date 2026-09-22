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
import { LinearConnectionSettings, LinearSetupForm } from './linear-setup'
function integration(state: 'pending' | 'reconnect_needed' | 'connected' | 'setup_required'): PublicLinearIntegration {
  return { ...makeChatIntegration(), id: 'int-1', agentSlug: 'a', provider: 'linear', settings: { runOnStatusChange: false }, hasCredentials: state === 'connected',
    authorizationPendingUntil: state === 'pending' ? Date.now() + 900_000 : undefined,
    linear: {
      id: 'int-1', agentSlug: 'a', provider: 'linear', outbound: { available: false, message: null }, name: 'Helper', status: 'disconnected', errorMessage: null,
      identity: null, authorized: state === 'connected', authorizationState: state,
      authorizationMessage: state === 'reconnect_needed' ? 'Authorization expired. Start again to connect Linear.' : null,
      canReconnect: state !== 'setup_required', runOnStatusChange: false,
      setup: { creationUrl: 'https://linear.app/settings/api/applications/new', redirectUri: 'https://gamut.example/callback' },
    } }
}
let client: QueryClient
let current: PublicLinearIntegration
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
  mocks.request.mockImplementation(async (url: string) => {
    if (url.includes('/providers/linear/setup?')) return Response.json(current.linear.setup)
    if (url === '/api/agent-integrations/agents/a') return Response.json(current)
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
