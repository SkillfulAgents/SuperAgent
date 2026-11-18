// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@renderer/components/ui/dialog'
import { agentIntegrationKeys } from '@renderer/hooks/use-agent-integrations'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'
import { makeChatIntegration } from './test-factories'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.request }))
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgent: () => ({ data: { name: 'Release Assistant' } }) }))
import { GitHubSetupForm, GitHubConnectionSettings } from './github-setup'
let client: QueryClient
let connected: boolean
let failAuthorization: boolean
const onClose = vi.fn()
const integration = () => ({ ...makeChatIntegration(), id: 'github-1', agentSlug: 'a', provider: 'github', settings: {}, hasCredentials: connected, authorizationPendingUntil: connected ? undefined : Date.now() + 900000 })
const creates = () => mocks.request.mock.calls.filter(([url, options]) => url === '/api/agent-integrations/agents/a' && options?.method === 'POST')
function renderForm() { return render(<QueryClientProvider client={client}><Dialog open><DialogContent><GitHubSetupForm agentSlug="a" onClose={onClose} /></DialogContent></Dialog></QueryClientProvider>) }
beforeEach(() => {
  vi.clearAllMocks(); connected = false; failAuthorization = false
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  mocks.request.mockImplementation(async (url: string) => {
    if (url.includes('/providers/github/setup?')) return Response.json({ transports: ['relay'] })
    if (url.endsWith('/authorize')) return failAuthorization ? Response.json({ error: 'Relay unavailable' }, { status: 400 }) : Response.json({ url: 'https://host.test/api/agent-integrations/providers/github/launch?state=valid' })
    return Response.json(integration())
  })
})
afterEach(() => client.clear())
it('uses the shared modal and creates nothing until the user continues', async () => {
  renderForm()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  expect(screen.getByTestId('integration-setup-layout')).toBeInTheDocument()
  expect(screen.getByLabelText('Integration name')).toHaveValue('Release Assistant')
  expect(creates()).toHaveLength(0)
})
it('launches the manifest flow and closes only when the callback has completed installation', async () => {
  renderForm()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('GitHub organization (optional)'), { target: { value: 'team' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith(expect.stringContaining('/providers/github/launch?state=')))
  expect(JSON.parse(creates()[0][1].body)).toMatchObject({ provider: 'github', config: { organization: 'team' } })
  expect(onClose).not.toHaveBeenCalled()
  connected = true
  await client.invalidateQueries({ queryKey: agentIntegrationKeys.detail('github-1') })
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(fakeLoginWindow.close).toHaveBeenCalled()
})
it('retries setup on the same row after a failed authorization launch', async () => {
  failAuthorization = true; renderForm()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Relay unavailable')
  failAuthorization = false
  fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }))
  await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalled())
  expect(creates()).toHaveLength(1)
})

it('shows the connected bot identity and reuses the same authorization flow for reconnect', async () => {
  render(<QueryClientProvider client={client}><GitHubConnectionSettings integration={{ ...makeChatIntegration(), id: 'github-1', agentSlug: 'a', provider: 'github', settings: { botLogin: 'release-helper[bot]', account: 'team', appUrl: 'https://github.com/apps/release-helper' } }} /></QueryClientProvider>)
  expect(screen.getByText('GitHub Account')).toBeInTheDocument()
  expect(screen.getByText('release-helper[bot] · team')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect GitHub' }))
  await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith(expect.stringContaining('/providers/github/launch')))
  expect(creates()).toHaveLength(0)
})
