// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeChatIntegration } from './test-factories'
import { fakeLoginWindow } from '@renderer/test/fake-login-window'

const AGENT = { slug: 'a', name: 'Infra Agent', description: '', avatar: { color: 'tonal-amber', shape: 'circle' } }
const state = vi.hoisted(() => ({ requests: [] as Array<{ url: string; method: string; body: any }> }))
vi.mock('@renderer/lib/api', () => {
  const apiFetch = async (url: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? 'GET'
    if (method !== 'GET') state.requests.push({ url, method, body: JSON.parse(options?.body ?? '{}') })
    if (url === '/api/agents/a') return Response.json(AGENT)
    if (url.endsWith('/authorize')) return Response.json({ url: 'https://provider.test/install?state=s' })
    return Response.json({ ok: true })
  }
  return { apiFetch, apiJson: async (url: string) => (await apiFetch(url)).json() }
})
vi.mock('@renderer/lib/oauth-popup', () => import('@renderer/test/fake-login-window'))
vi.mock('./agent-app-icon', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agent-app-icon')>(),
  agentAppIconBase64: async () => 'iVBORw0KGgo=',
}))
import { ProvisionedAppCard } from './provisioned-app-card'
import { SlackAppAppearanceCard } from './slack-app-appearance'

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const slack = { botTokenSaved: true, appTokenSaved: false, signingSecretSaved: true, webhook: { url: 'https://relay.test/h', status: 'verified' as const } }

beforeEach(() => {
  vi.clearAllMocks()
  state.requests = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})

describe('the app a team directory created', () => {
  it('finishes an install that was left halfway', async () => {
    const integration = makeChatIntegration({ id: 'int-1', provider: 'slack', provisionedApp: { directoryId: 'd', installed: false, name: 'Infra Agent', iconSet: true } })
    render(<ProvisionedAppCard integration={integration} />, { wrapper })
    fireEvent.click(screen.getByTestId('provisioned-app-finish-install'))
    await waitFor(() => expect(fakeLoginWindow.navigate).toHaveBeenCalledWith('https://provider.test/install?state=s'))
    expect(state.requests).toEqual([{ url: '/api/agent-integrations/int-1/authorize', method: 'POST', body: {} }])
  })

  it('renames it and gives it the agent’s avatar as its icon', async () => {
    const integration = makeChatIntegration({ id: 'int-1', provider: 'slack', slack,
      provisionedApp: { directoryId: 'd', installed: true, name: 'Infra Agent', iconSet: false, settingsUrl: 'https://api.slack.com/apps/A1' } })
    render(<ProvisionedAppCard integration={integration} />, { wrapper })
    expect(screen.getByRole('link', { name: /App settings/ })).toHaveAttribute('href', 'https://api.slack.com/apps/A1')
    expect(screen.getByTestId('provisioned-app-rename')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('App name and handle'), { target: { value: 'Ops Agent' } })
    fireEvent.click(screen.getByTestId('provisioned-app-rename'))
    await waitFor(() => expect(state.requests[0]).toEqual({ url: '/api/agent-integrations/int-1/app', method: 'POST', body: { name: 'Ops Agent' } }))

    await waitFor(() => expect(screen.getByTestId('provisioned-app-icon')).toHaveTextContent('Set icon'))
    fireEvent.click(screen.getByTestId('provisioned-app-icon'))
    await waitFor(() => expect(state.requests[1]).toEqual({ url: '/api/agent-integrations/int-1/app', method: 'POST', body: { icon: 'iVBORw0KGgo=' } }))
  })

  it('points an app made by hand at its settings in Slack to rename it', async () => {
    render(<SlackAppAppearanceCard integration={makeChatIntegration({ provider: 'slack', slack: { ...slack, appId: 'A777' } })} />, { wrapper })
    expect(await screen.findByTestId('slack-rename-in-slack')).toHaveAttribute('href', 'https://api.slack.com/apps/A777')
  })

  it('leaves a created app’s look to its own card', () => {
    const { container } = render(<SlackAppAppearanceCard integration={makeChatIntegration({ provider: 'slack', slack,
      provisionedApp: { directoryId: 'd', installed: true, name: 'Infra Agent', iconSet: true } })} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })
})
