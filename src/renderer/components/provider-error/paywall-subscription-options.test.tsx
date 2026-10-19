// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { PaywallSubscriptionOptions } from './paywall-subscription-options'

const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  track: vi.fn(),
  isAuthMode: true,
  isAdmin: false,
  canUseAgent: true,
  isActive: false,
}))
vi.mock('@renderer/lib/api', () => ({ apiFetch: state.fetch }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: state.track }) }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: { id: 'me' }, isAuthMode: state.isAuthMode, isAdmin: state.isAdmin, canUseAgent: () => state.canUseAgent }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => ({ isActive: state.isActive }) }))
vi.mock('@renderer/hooks/use-settings', async importOriginal => ({
  ...await importOriginal<typeof import('@renderer/hooks/use-settings')>(),
  useModelSettings: () => ({ data: { llmProviderStatus: [], modelPricing: {} } }),
}))

let client: QueryClient
let saved: ConnectionInfo[]
let createCount: number
let sendCount: number
let failSend: boolean
let failSave: boolean
let failAgentDefault: boolean
let queued: boolean
let queueCancelled: boolean
let emptyCatalog: boolean
let usageByConnection: Record<string, unknown>
const onResumed = vi.fn()
const session = { sessionId: 'chat', agentSlug: 'agent' }
const analytics = { paywallId: 'wall', entryPoint: 'platform_paywall' as const, paywallType: 'subscription', ctaKind: 'subscribe', placement: 'composer' }
const events = (step: string) => state.track.mock.calls
  .filter(([event]) => event === `paywall_subscription_${step}`).map(([, properties]) => properties)

function mount(strict = false) {
  const content = (
    <QueryClientProvider client={client}>
      <PaywallSubscriptionOptions session={session} onResumed={onResumed} analytics={analytics} />
    </QueryClientProvider>
  )
  return render(strict ? <StrictMode>{content}</StrictMode> : content)
}

function openClaude() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect Claude Code' }))
  fireEvent.change(screen.getByLabelText('Subscription token'), { target: { value: 'test-setup-token' } })
}
function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save and resume chat' }))
}
function savedSubscription(overrides: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return {
    id: 'saved-grok', name: 'Personal Grok', provider: 'grok-subscription',
    userId: 'me', ownerName: 'Me', isConfigured: true, managed: false,
    supportsUsage: true,
    catalog: [{ id: 'grok-model', label: 'Grok', contextWindow: 200000, supportedEfforts: [] }],
    defaultModel: 'grok-model', modelOverrides: [], browserModel: null, dashboardModel: null,
    canManage: true, canDelete: true,
    ...overrides,
  }
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(['session', 'chat', 'agent'], { id: 'chat', llmProviderId: 'platform', model: 'old-model' })
  state.isAuthMode = true
  state.isAdmin = false
  state.canUseAgent = true
  state.isActive = false
  state.track.mockReset()
  saved = []
  usageByConnection = {}
  createCount = 0
  sendCount = 0
  failSend = false
  failSave = false
  failAgentDefault = false
  queued = false
  queueCancelled = true
  emptyCatalog = false
  state.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const data = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.endsWith('/start')) return Response.json({ id: 'login', url: 'https://example.test/sign-in', code: 'CODE', interval: 0.01 })
    if (url.endsWith('/poll')) return Response.json({ status: 'connected', accountLabel: 'me@example.test' })
    if (url === '/api/llm-connections' && init?.method === 'POST') {
      createCount++
      if (failSave) return Response.json({ error: 'Could not save connection' }, { status: 500 })
      saved.push({
        id: 'new-connection', name: data.name, provider: data.provider,
        userId: data.userId, ownerName: 'Me', isConfigured: true, managed: false,
        catalog: emptyCatalog ? [] : [{ id: 'new-model', label: 'New model', contextWindow: 200000, supportedEfforts: [] }],
        defaultModel: 'new-model', modelOverrides: [], browserModel: null, dashboardModel: null,
        canManage: true, canDelete: true,
      })
      return Response.json({ id: 'new-connection' })
    }
    if (url === '/api/llm-connections') return Response.json({ connections: saved, defaultSelection: { llmProviderId: 'platform', model: 'old-model' }, summarizerSelection: null })
    const usageMatch = url.match(/^\/api\/llm-connections\/([^/]+)\/usage\?refreshCredentials=1$/)
    if (usageMatch) {
      const usage = usageByConnection[decodeURIComponent(usageMatch[1])]
      if (usage === 'error') return Response.json({ error: 'Usage unavailable' }, { status: 503 })
      return Response.json(usage ?? {
        status: 'available', observedAt: new Date().toISOString(),
        limits: [{ kind: 'window', id: 'weekly', label: 'Weekly', usedPercent: 50 }],
      })
    }
    if (url === '/api/llm-connections/defaults/default' && init?.method === 'PUT') return Response.json({
      success: true,
      before: { defaultSelection: { llmProviderId: 'platform', model: 'old-model' }, summarizerSelection: null },
      after: { defaultSelection: data, summarizerSelection: { llmProviderId: 'platform', model: 'old-model' } },
    })
    if (url === '/api/llm-connections/defaults/default/compare-and-set' && init?.method === 'PUT') return Response.json({ updated: true })
    if (url === '/api/agents/agent/preferences' && init?.method === 'PUT') {
      return failAgentDefault ? Response.json({ error: 'Could not update agent default' }, { status: 500 }) : Response.json(data)
    }
    if (url.includes('/queued-messages/') && init?.method === 'DELETE') return Response.json({ cancelled: queueCancelled })
    if (url.endsWith('/messages')) {
      sendCount++
      return failSend
        ? Response.json({ error: 'Could not resume' }, { status: 500 })
        : Response.json({ success: true, uuid: 'message', queued })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
})

afterEach(async () => { cleanup(); await Promise.resolve(); client.clear(); vi.clearAllMocks() })

describe('subscription paywall recovery', () => {
  it('switches an active saved connection for only the blocked session', async () => {
    saved = [savedSubscription()]
    mount()
    expect(await screen.findByText('Personal Grok')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Switch for this session' }))
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    const send = state.fetch.mock.calls.find(([url]) => url.endsWith('/messages'))
    expect(JSON.parse(String(send?.[1].body))).toEqual({ content: 'Continue', llmProviderId: 'saved-grok', model: 'grok-model' })
    expect(state.fetch.mock.calls.some(([url]) => url === '/api/llm-connections/defaults/default')).toBe(false)
    expect(state.fetch.mock.calls.some(([url]) => url === '/api/agents/agent/preferences')).toBe(false)
    expect(events('switched')).toEqual([expect.objectContaining({ ...analytics, provider: 'grok-subscription', scope: 'session' })])
    expect(onResumed).toHaveBeenCalledWith(expect.objectContaining({ provider: 'grok-subscription', scope: 'session' }))
  })

  it('keeps the paywall and does not track a saved switch when the resume is queued', async () => {
    queued = true
    saved = [savedSubscription()]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Switch for this session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('chat is still busy')
    expect(onResumed).not.toHaveBeenCalled()
    expect(events('switched')).toHaveLength(0)
    expect(state.fetch).toHaveBeenCalledWith('/api/agents/agent/sessions/chat/queued-messages/message', { method: 'DELETE' })
  })

  it('does not invite an immediate retry when a queued continuation already started', async () => {
    queued = true
    queueCancelled = false
    saved = [savedSubscription()]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Switch for this session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already started this continuation')
    expect(onResumed).not.toHaveBeenCalled()
    expect(events('switched')).toHaveLength(0)
  })

  it('writes both defaults before resuming when an authorized user always selects a saved connection', async () => {
    state.isAuthMode = false
    saved = [savedSubscription({ userId: null })]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Always use Grok' }))
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    const defaultWrite = state.fetch.mock.calls.find(([url]) => url === '/api/llm-connections/defaults/default')
    const preferenceWrite = state.fetch.mock.calls.find(([url]) => url === '/api/agents/agent/preferences')
    expect(JSON.parse(String(defaultWrite?.[1].body))).toEqual({ llmProviderId: 'saved-grok', model: 'grok-model' })
    expect(JSON.parse(String(preferenceWrite?.[1].body))).toEqual({ defaultLlmProviderId: 'saved-grok', defaultModel: 'grok-model' })
    const urls = state.fetch.mock.calls.map(([url]) => url)
    expect(urls.indexOf('/api/llm-connections/defaults/default')).toBeLessThan(urls.indexOf('/api/agents/agent/preferences'))
    expect(urls.indexOf('/api/agents/agent/preferences')).toBeLessThan(urls.findIndex(url => url.endsWith('/messages')))
    expect(events('switched')).toEqual([expect.objectContaining({ provider: 'grok-subscription', scope: 'always', paywallId: 'wall' })])
    expect(onResumed).toHaveBeenCalledWith(expect.objectContaining({ provider: 'grok-subscription', scope: 'always' }))
  })

  it('offers Always use when the workspace has no app default yet', async () => {
    state.isAuthMode = false
    saved = [savedSubscription({ userId: null })]
    const implementation = state.fetch.getMockImplementation()!
    state.fetch.mockImplementation((url: string, init?: RequestInit) => url === '/api/llm-connections' && !init?.method
      ? Promise.resolve(Response.json({ connections: saved, defaultSelection: null, summarizerSelection: null }))
      : implementation(url, init))
    mount()
    const always = await screen.findByRole('button', { name: 'Always use Grok' })
    expect(always).toBeEnabled()
    fireEvent.click(always)
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    expect(events('switched')).toEqual([expect.objectContaining({ scope: 'always' })])
  })

  it('restores the previous app default when the agent-default write fails', async () => {
    state.isAuthMode = false
    failAgentDefault = true
    saved = [savedSubscription({ userId: null })]
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Always use Grok' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update agent default')
    const defaultWrites = state.fetch.mock.calls.filter(([url]) => url.startsWith('/api/llm-connections/defaults/default'))
    expect(defaultWrites.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ['/api/llm-connections/defaults/default', { llmProviderId: 'saved-grok', model: 'grok-model' }],
      ['/api/llm-connections/defaults/default/compare-and-set', {
        expected: {
          defaultSelection: { llmProviderId: 'saved-grok', model: 'grok-model' },
          summarizerSelection: { llmProviderId: 'platform', model: 'old-model' },
        },
        restore: { defaultSelection: { llmProviderId: 'platform', model: 'old-model' }, summarizerSelection: null },
      }],
    ])
    expect(sendCount).toBe(0)
    expect(events('switched')).toHaveLength(0)
  })

  it('rolls back to the server pre-write state when another admin edited defaults after the paywall loaded', async () => {
    state.isAuthMode = false
    failAgentDefault = true
    saved = [savedSubscription({ userId: null })]
    const before = {
      defaultSelection: { llmProviderId: 'other-default', model: 'other-model' },
      summarizerSelection: { llmProviderId: 'new-helper', model: 'helper-model' },
    }
    const after = { ...before, defaultSelection: { llmProviderId: 'saved-grok', model: 'grok-model' } }
    const implementation = state.fetch.getMockImplementation()!
    state.fetch.mockImplementation((url: string, init?: RequestInit) =>
      url === '/api/llm-connections/defaults/default' && init?.method === 'PUT'
        ? Promise.resolve(Response.json({ success: true, before, after }))
        : implementation(url, init))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Always use Grok' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update agent default')
    const restore = state.fetch.mock.calls.find(([url]) => url.endsWith('/compare-and-set'))
    expect(JSON.parse(String(restore?.[1].body))).toEqual({ expected: after, restore: before })
    expect(sendCount).toBe(0)
  })

  it('does not resume an abandoned session after default writes finish', async () => {
    state.isAuthMode = false
    saved = [savedSubscription({ userId: null })]
    let release!: (response: Response) => void
    const implementation = state.fetch.getMockImplementation()!
    state.fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/agents/agent/preferences' && init?.method === 'PUT') {
        return new Promise<Response>(resolve => { release = resolve })
      }
      return implementation(url, init)
    })
    const view = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Always use Grok' }))
    await waitFor(() => expect(release).toBeDefined())
    view.unmount()
    await act(async () => { release(Response.json({ defaultLlmProviderId: 'saved-grok', defaultModel: 'grok-model' })) })
    expect(sendCount).toBe(0)
    expect(events('switched')).toHaveLength(0)
  })

  it('does not offer an explicitly exhausted saved connection', async () => {
    saved = [savedSubscription()]
    usageByConnection['saved-grok'] = {
      status: 'available', observedAt: new Date().toISOString(),
      limits: [{ kind: 'window', id: 'weekly', label: 'Weekly', usedPercent: 100 }],
    }
    mount()
    await waitFor(() => expect(client.getQueryState(['llm-provider-usage', 'saved-grok', 'me', true, true])?.status).toBe('success'))
    expect(screen.queryByText('Personal Grok')).not.toBeInTheDocument()
    expect(screen.queryByText('Use an active subscription')).not.toBeInTheDocument()
  })

  it('uses the concrete MiniMax model when filtering model-specific usage windows', async () => {
    saved = [savedSubscription({
      id: 'saved-minimax', name: 'MiniMax Plan', provider: 'minimax-subscription', defaultModel: 'minimax',
      catalog: [{ id: 'MiniMax-M3.1-Flash-Preview', label: 'MiniMax', family: 'minimax', isLatest: true, contextWindow: 200000, supportedEfforts: [] }],
    })]
    usageByConnection['saved-minimax'] = {
      status: 'available', observedAt: new Date().toISOString(), limits: [
        { kind: 'window', id: '0-weekly', label: 'MiniMax-M3 · Weekly', usedPercent: 100 },
        { kind: 'window', id: '1-weekly', label: 'MiniMax-M3.1-Flash-Preview · Weekly', usedPercent: 20 },
      ],
    }
    mount()
    expect(await screen.findByText('MiniMax Plan')).toBeVisible()
  })

  it.each([
    ['unavailable', { status: 'unavailable', observedAt: '2026-10-19T00:00:00.000Z', limits: [] }, 'success', false],
    ['unsupported', { status: 'unsupported', observedAt: '2026-10-19T00:00:00.000Z', limits: [] }, 'success', true],
    ['failed', 'error', 'error', false],
  ] as const)('%s usage reads produce the expected saved-connection eligibility', async (_name, usage, status, shown) => {
    saved = [savedSubscription()]
    usageByConnection['saved-grok'] = usage
    mount()
    await waitFor(() => expect(client.getQueryState(['llm-provider-usage', 'saved-grok', 'me', true, true])?.status).toBe(status))
    if (shown) expect(await screen.findByText('Personal Grok')).toBeVisible()
    else expect(screen.queryByText('Personal Grok')).not.toBeInTheDocument()
  })

  it('offers configured subscriptions that do not support usage reads', async () => {
    saved = [savedSubscription({
      id: 'saved-claude', name: 'Claude Code', provider: 'claude-subscription', supportsUsage: false,
      catalog: [{ id: 'claude-model', label: 'Claude', contextWindow: 200000, supportedEfforts: [] }],
      defaultModel: 'claude-model',
    })]
    mount()
    expect(await screen.findByTestId('active-subscription-connections')).toHaveTextContent('Claude Code')
    expect(state.fetch.mock.calls.some(([url]) => url.includes('/saved-claude/usage'))).toBe(false)
  })

  it('keeps session switching available but protects app-wide defaults for personal cloud connections', async () => {
    saved = [savedSubscription()]
    mount()
    expect(await screen.findByRole('button', { name: 'Switch for this session' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Always use Grok' })).toBeDisabled()
  })

  it.each([
    ['Grok', 'grok', 'Grok'],
    ['OpenAI', 'codex', 'Codex'],
    ['Kimi', 'kimi', 'Kimi'],
    ['MiniMax', 'minimax', 'MiniMax'],
  ])('connects %s using its existing sign-in form, saves it personally, and resumes the chat', async (name, provider, signInName) => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: `Connect ${name}` }))
    expect(screen.getByRole('button', { name: 'Save and resume chat' })).toBeDisabled()
    expect(screen.queryByText('Available to')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `Sign in with ${signInName}` }))
    await screen.findByText('me@example.test')
    save()
    await waitFor(() => expect(onResumed).toHaveBeenCalledTimes(1))
    const create = state.fetch.mock.calls.find(([url, init]) => url === '/api/llm-connections' && init?.method === 'POST')
    expect(JSON.parse(create?.[1].body)).toMatchObject({ provider: `${provider}-subscription`, userId: 'me', oauthLoginId: 'login' })
    const send = state.fetch.mock.calls.find(([url]) => url.endsWith('/messages'))
    expect(send?.[0]).toBe('/api/agents/agent/sessions/chat/messages')
    expect(JSON.parse(send?.[1].body)).toEqual({ content: 'Continue', llmProviderId: 'new-connection', model: 'new-model' })
    expect(client.getQueryData(['session', 'chat', 'agent'])).toMatchObject({ llmProviderId: 'new-connection', model: 'new-model' })
    expect(createCount).toBe(1)
    expect(sendCount).toBe(1)
    expect(state.fetch.mock.calls.some(([url]) => url.includes('/defaults/'))).toBe(false)
    const trace = state.track.mock.calls.filter(([event]) => event !== 'paywall_subscription_options_shown')
    expect(trace.map(([event]) => event)).toEqual([
      'paywall_subscription_clicked', 'paywall_subscription_sign_in_started',
      'paywall_subscription_sign_in_succeeded', 'paywall_subscription_save_started',
      'paywall_subscription_saved', 'paywall_subscription_resume_started', 'paywall_subscription_resumed',
    ])
    const attemptId = events('clicked')[0].attemptId
    for (const [, properties] of trace) {
      expect(properties).toMatchObject({ ...analytics, attemptId, provider: `${provider}-subscription`, authMethod: 'device_code', elapsedMs: expect.any(Number) })
    }
    expect(events('resumed')[0]).toMatchObject({ outcome: 'message_accepted', resumeAttempt: 1 })
    expect(JSON.stringify(trace)).not.toMatch(/me@example.test|CODE|new-connection|new-model/)
  })

  it('connects Claude Code with the existing setup-token content on a local workspace', async () => {
    state.isAuthMode = false
    mount()
    openClaude()
    expect(screen.getByText('claude setup-token')).toBeVisible()
    save()
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    const create = state.fetch.mock.calls.find(([url, init]) => url === '/api/llm-connections' && init?.method === 'POST')
    expect(JSON.parse(create?.[1].body)).toMatchObject({ provider: 'claude-subscription', userId: null, config: { apiKeys: { claudeSubscriptionToken: 'test-setup-token' } } })
    expect(events('token_entered')).toHaveLength(1)
    expect(events('sign_in_succeeded')).toHaveLength(0)
    expect(events('saved')[0]).toMatchObject({ authMethod: 'setup_token', saveAttempt: 1 })
    expect(JSON.stringify(state.track.mock.calls)).not.toContain('test-setup-token')
  })

  it('retries resuming with the already-saved connection after a failed send', async () => {
    failSend = true
    mount()
    openClaude()
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to send message')
    expect(onResumed).not.toHaveBeenCalled()
    expect(client.getQueryData(['session', 'chat', 'agent'])).toMatchObject({ llmProviderId: 'platform' })
    failSend = false
    fireEvent.click(screen.getByRole('button', { name: 'Resume chat' }))
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    expect(createCount).toBe(1)
    expect(sendCount).toBe(2)
    expect(events('resume_failed')[0]).toMatchObject({ failureReason: 'send_failed', resumeAttempt: 1 })
    expect(events('resumed')[0]).toMatchObject({ attemptId: events('clicked')[0].attemptId, resumeAttempt: 2 })
    expect(events('saved')).toHaveLength(1)
  })

  it('keeps setup open and does not resume when saving fails', async () => {
    failSave = true
    mount()
    openClaude()
    save()
    await waitFor(() => expect(createCount).toBe(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and resume chat' })).toBeEnabled())
    expect(screen.getByLabelText('Subscription token')).toHaveValue('test-setup-token')
    expect(sendCount).toBe(0)
    expect(onResumed).not.toHaveBeenCalled()
    expect(events('save_failed')[0]).toMatchObject({ saveAttempt: 1 })
    expect(events('saved')).toHaveLength(0)
    expect(events('resume_started')).toHaveLength(0)
    failSave = false
    save()
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    expect(events('saved')[0]).toMatchObject({ attemptId: events('clicked')[0].attemptId, saveAttempt: 2 })
  })

  it('does not send when the saved subscription has no usable model', async () => {
    emptyCatalog = true
    mount()
    openClaude()
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('no model is available')
    expect(sendCount).toBe(0)
    expect(onResumed).not.toHaveBeenCalled()
    expect(events('resume_failed')[0]).toMatchObject({ failureReason: 'model_unavailable' })
    expect(events('resumed')).toHaveLength(0)
  })

  it('waits for the previous turn to finish before automatically resuming', async () => {
    state.isActive = true
    const view = mount()
    openClaude()
    save()
    await screen.findByText('Waiting for the current turn to finish…')
    expect(sendCount).toBe(0)
    state.isActive = false
    view.rerender(<QueryClientProvider client={client}><PaywallSubscriptionOptions session={session} onResumed={onResumed} analytics={analytics} /></QueryClientProvider>)
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    expect(sendCount).toBe(1)
  })

  it('does not report a provider switch when another window starts the queued continuation', async () => {
    queued = true
    queueCancelled = false
    mount()
    openClaude()
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('already started this continuation')
    expect(onResumed).not.toHaveBeenCalled()
    expect(client.getQueryData(['session', 'chat', 'agent'])).toMatchObject({ llmProviderId: 'platform' })
    expect(events('resume_failed')[0]).toMatchObject({ failureReason: 'chat_busy' })
    expect(events('resumed')).toHaveLength(0)
    expect(state.fetch).toHaveBeenCalledWith('/api/agents/agent/sessions/chat/queued-messages/message', { method: 'DELETE' })
  })

  it('cancels setup without saving or resuming', () => {
    mount()
    openClaude()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(createCount).toBe(0)
    expect(sendCount).toBe(0)
    expect(events('cancelled')).toEqual([expect.objectContaining({ reason: 'dismissed', connectionSaved: false, lastStep: 'token_entered' })])
  })

  it('does not resume after navigating away while the saved connection refreshes', async () => {
    let release!: (response: Response) => void
    const implementation = state.fetch.getMockImplementation()!
    state.fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/llm-connections' && !init?.method && createCount > 0) {
        return new Promise<Response>(resolve => { release = resolve })
      }
      return implementation(url, init)
    })
    const view = mount()
    openClaude()
    save()
    await waitFor(() => expect(release).toBeDefined())
    view.unmount()
    await act(async () => { release(Response.json({ connections: saved })) })
    expect(sendCount).toBe(0)
    expect(onResumed).not.toHaveBeenCalled()
    expect(events('saved')).toHaveLength(1)
    expect(events('cancelled')).toEqual([expect.objectContaining({ reason: 'unmounted', connectionSaved: true, lastStep: 'saved' })])
  })

  it('does not offer recovery to users who cannot send messages to the agent', () => {
    state.canUseAgent = false
    mount()
    expect(screen.queryByTestId('paywall-subscriptions')).not.toBeInTheDocument()
    expect(state.track).not.toHaveBeenCalled()
  })

  it('records recovery after the stream hides the paywall before the send response arrives', async () => {
    let release!: (response: Response) => void
    const implementation = state.fetch.getMockImplementation()!
    state.fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/messages')) return new Promise<Response>(resolve => { release = resolve })
      return implementation(url, init)
    })
    const view = mount()
    openClaude()
    save()
    await waitFor(() => expect(release).toBeDefined())
    view.unmount()
    await act(async () => {})
    expect(events('cancelled')).toHaveLength(0)
    await act(async () => { release(Response.json({ success: true, uuid: 'message', queued: false })) })
    expect(events('resumed')).toHaveLength(1)
    expect(events('cancelled')).toHaveLength(0)
    expect(onResumed).toHaveBeenCalledOnce()
  })

  it('does not double-count impressions or cancel a successful attempt in Strict Mode', async () => {
    const view = mount(true)
    openClaude()
    await act(async () => {})
    expect(events('options_shown')).toHaveLength(1)
    expect(events('cancelled')).toHaveLength(0)
    save()
    await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => {})
    expect(events('resumed')).toHaveLength(1)
    expect(events('cancelled')).toHaveLength(0)
  })

  it('starts a new attempt after dismissal and keeps the paywall correlation', async () => {
    mount()
    openClaude()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Connect OpenAI' }))
    const clicks = events('clicked')
    expect(clicks).toHaveLength(2)
    expect(clicks[1].attemptId).not.toBe(clicks[0].attemptId)
    expect(clicks.map(event => event.paywallId)).toEqual(['wall', 'wall'])
    expect(events('cancelled')).toHaveLength(1)
    expect(events('cancelled')[0].attemptId).toBe(clicks[0].attemptId)
  })

  it('continues the chat even if the analytics SDK throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      state.track.mockImplementation(() => { throw new Error('Analytics unavailable') })
      mount()
      openClaude()
      save()
      await waitFor(() => expect(onResumed).toHaveBeenCalledOnce())
      expect(sendCount).toBe(1)
    } finally { warn.mockRestore() }
  })
})
