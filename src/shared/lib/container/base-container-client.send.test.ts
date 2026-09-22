import { afterEach, describe, expect, it, vi } from 'vitest'
import { BaseContainerClient } from './base-container-client'
import { MessageNotAcceptedError } from './message-dispatch-error'
import type { ContainerInfo } from './types'
vi.mock('./host-token-store', () => ({ getOrCreateHostToken: () => 'test-host-token' }))
vi.mock('../config/settings', () => ({ getSettings: () => ({}), getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'allow' }) }))
class Client extends BaseContainerClient {
  constructor(private readonly info: ContainerInfo = { status: 'running', port: 1234 }) { super({ agentId: 'test' }) }
  protected getRunnerCommand() { return 'unused' }
  override async getInfo() { return this.info }
}
afterEach(() => vi.unstubAllGlobals())
describe('runtime handoff rejection evidence', () => {
  it('marks a stopped-container preflight as safe to retry, without sending HTTP', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new Client({ status: 'stopped' }).sendMessage('session', 'message')).rejects.toMatchObject({ reason: 'unavailable' })
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
