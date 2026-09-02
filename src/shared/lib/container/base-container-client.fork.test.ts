import { describe, expect, it, vi } from 'vitest'
import type { ContainerConfig, ContainerInfo } from './types'
import { ContainerConflictError, ContainerNotFoundError } from './types'
import { BaseContainerClient } from './base-container-client'

vi.mock('@shared/lib/container/host-token-store', () => ({ getOrCreateHostToken: () => 'test-host-token' }))
vi.mock('@shared/lib/config/settings', () => ({ getSettings: () => ({ enableToolSearch: true }) }))
vi.mock('@shared/lib/llm-provider', () => ({ getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }) }))

class StubFetchClient extends BaseContainerClient {
  constructor(private readonly response: Response) {
    super({ agentId: 'test-agent' } as ContainerConfig)
  }
  protected getRunnerCommand(): string { return 'docker' }
  async getInfoFromRuntime(): Promise<ContainerInfo> { return { status: 'running', port: 1 } }
  override async fetch(): Promise<Response> { return this.response }
}

describe('BaseContainerClient.forkSession', () => {
  it('returns null when the container predates the fork route (404)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new StubFetchClient(new Response('404 Not Found', { status: 404 }))
    expect(await client.forkSession('src-1')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('predates the fork endpoint'))
    warn.mockRestore()
  })

  it('throws ContainerNotFoundError when the session is gone (JSON 404)', async () => {
    const client = new StubFetchClient(Response.json({ error: 'Session not found' }, { status: 404 }))
    await expect(client.forkSession('src-1')).rejects.toBeInstanceOf(ContainerNotFoundError)
  })

  it('throws ContainerConflictError on 409', async () => {
    const client = new StubFetchClient(Response.json({ error: 'busy', code: 'session_busy' }, { status: 409 }))
    await expect(client.forkSession('src-1')).rejects.toBeInstanceOf(ContainerConflictError)
  })

  it('returns the new id on 201', async () => {
    const client = new StubFetchClient(Response.json({ id: 'fork-1' }, { status: 201 }))
    expect(await client.forkSession('src-1')).toEqual({ id: 'fork-1' })
  })
})
