import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseContainerClient } from './base-container-client'
import { MessageNotAcceptedError } from './message-dispatch-error'
import * as settings from '../config/settings'
import * as providerRuntime from '../llm-provider/connection-runtime'
import type { ContainerInfo } from './types'
vi.mock('./host-token-store', () => ({ getOrCreateHostToken: () => 'test-host-token' }))
vi.mock('../config/settings', () => ({ getSettings: () => ({}), getModelCatalogSettings: () => ({}), getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'allow' }) }))
// These tests isolate HTTP acceptance evidence; provider persistence has its
// own database-backed coverage in base-container-client.llm-provider.test.ts.
vi.mock('../llm-provider/connections', () => ({
  storedSelection: () => null,
  resolveExecutionSelection: async () => ({ llmProviderId: 'provider', model: 'test-model' }),
}))
vi.mock('../llm-provider/connection-runtime', () => ({
  connectionRuntime: async () => ({ llmProviderId: 'provider', model: 'test-model', modelPromptHints: [], subagentModels: [], modelContextWindows: {}, env: {} }),
  rememberSessionRuntime: () => {},
}))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({
  sessions: { metadata: async () => ({}), updateMetadata: async () => {} },
  config: { get: async () => ({}) },
}) } }))
class Client extends BaseContainerClient {
  constructor(private readonly info: ContainerInfo = { status: 'running', port: 1234 }) { super({ agentId: 'test' }) }
  protected getRunnerCommand() { return 'unused' }
  override async getInfo() { return this.info }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('runtime handoff rejection evidence', () => {
  it('forwards the nonempty initial input and stable UUID to POST /sessions', async () => {
    const fetch = vi.fn(async (_url: string, request: RequestInit) => {
      const body = JSON.parse(request.body as string)
      // The production route rejects falsy initialMessage before createSession.
      if (!body.initialMessage) return Response.json({ error: 'initialMessage is required' }, { status: 400 })
      return Response.json({ id: 'created-session' }, { status: 201 })
    })
    vi.stubGlobal('fetch', fetch)
    await expect(new Client().createSession({ initialMessage: 'first input', initialMessageUuid: 'delivery-id' })).resolves.toMatchObject({ id: 'created-session' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toMatch(/\/sessions$/)
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ initialMessage: 'first input', initialMessageUuid: 'delivery-id' })
  })
  it('marks creation preflight as safe to retry before issuing HTTP', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new Client({ status: 'stopped', port: null }).createSession({ initialMessage: 'message' })).rejects.toMatchObject({ reason: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps a lost creation response ambiguous because the initial input may have run', async () => {
    const fetch = vi.fn(async () => { throw new Error('connection reset') }); vi.stubGlobal('fetch', fetch)
    const failure = await new Client().createSession({ initialMessage: 'first input' }).catch(error => error)
    expect(fetch).toHaveBeenCalledOnce()
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(MessageNotAcceptedError)
  })
  it.each([400, 500, 503])('preserves explicit runtime rejection evidence on HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'startup failed', inputAccepted: false, code: 'EAGAIN', errorClass: 'executable_launch_failed' }, { status })))
    await expect(new Client().createSession({ initialMessage: 'first input' })).rejects.toMatchObject({ reason: 'rejected', status, containerErrorCode: 'EAGAIN', containerErrorClass: 'executable_launch_failed' })
  })
  it('recognizes an older container’s explicit SDK launch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'spawn failed', errorClass: 'executable_launch_failed', code: 'EAGAIN' }, { status: 500 })))
    await expect(new Client().createSession({ initialMessage: 'first input' })).rejects.toMatchObject({ reason: 'rejected', status: 500, containerErrorClass: 'executable_launch_failed' })
  })
  it('retries local request preparation failures without issuing HTTP', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    vi.spyOn(settings, 'getAgentCapabilitySettings').mockImplementationOnce(() => { throw new Error('settings temporarily unavailable') })
    await expect(new Client().createSession({ initialMessage: 'first input' })).rejects.toMatchObject({ reason: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['create', 'send'] as const)('retries %s provider resolution failures before input dispatch', async operation => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    vi.spyOn(providerRuntime, 'connectionRuntime').mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    const client = new Client()
    await expect(operation === 'create'
      ? client.createSession({ initialMessage: 'first input' })
      : client.sendMessage('session', 'follow-up')).rejects.toMatchObject({ reason: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])('recognizes %s as proof the creation request was not delivered', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code }) }) }))
    await expect(new Client().createSession({ initialMessage: 'first input' })).rejects.toMatchObject({ reason: 'unavailable' })
  })
  it.each(['ECONNRESET', 'ETIMEDOUT'])('keeps %s after dispatch ambiguous', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('read'), { code }) }) }))
    const error = await new Client().createSession({ initialMessage: 'first input' }).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MessageNotAcceptedError)
  })
  it('does not infer non-acceptance from an unmarked creation error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'No message was sent' }, { status: 500 })))
    const error = await new Client().createSession({ initialMessage: 'first input' }).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MessageNotAcceptedError)
  })
  it('marks a stopped-container preflight as safe to retry, without sending HTTP', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new Client({ status: 'stopped', port: null }).sendMessage('session', 'message')).rejects.toMatchObject({ reason: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('marks the runtime session-lookup 404 as a definite rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Session not found' }, { status: 404 })))
    await expect(new Client().sendMessage('session', 'message')).rejects.toMatchObject({ reason: 'session-gone' })
  })
  it.each(['Session not found', 'Container is not running'])('keeps a 500 with %j ambiguous', async error => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error }, { status: 500 })))
    const failure = await new Client().sendMessage('session', 'message').catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(MessageNotAcceptedError)
  })
  it('does not mistake a lost response for proof of rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset') }))
    const failure = await new Client().sendMessage('session', 'message').catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(MessageNotAcceptedError)
  })
})
