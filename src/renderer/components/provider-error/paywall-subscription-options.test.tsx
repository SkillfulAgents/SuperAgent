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
  canUseAgent: true,
  isActive: false,
}))
vi.mock('@renderer/lib/api', () => ({ apiFetch: state.fetch }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: state.track }) }))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: { id: 'me' }, isAuthMode: state.isAuthMode, canUseAgent: () => state.canUseAgent }),
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
let queued: boolean
let emptyCatalog: boolean
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

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(['session', 'chat', 'agent'], { id: 'chat', llmProviderId: 'platform', model: 'old-model' })
  state.isAuthMode = true
  state.canUseAgent = true
  state.isActive = false
  state.track.mockReset()
  saved = []
  createCount = 0
  sendCount = 0
  failSend = false
  failSave = false
  queued = false
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

  it('does not report a provider switch when another window causes the send to be queued', async () => {
    queued = true
    mount()
    openClaude()
    save()
    expect(await screen.findByRole('alert')).toHaveTextContent('chat is still busy')
    expect(onResumed).not.toHaveBeenCalled()
    expect(client.getQueryData(['session', 'chat', 'agent'])).toMatchObject({ llmProviderId: 'platform' })
    expect(events('resume_failed')[0]).toMatchObject({ failureReason: 'chat_busy' })
    expect(events('resumed')).toHaveLength(0)
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
