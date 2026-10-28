import { afterEach, describe, expect, it, vi } from 'vitest'
import net from 'net'
import type { AddressInfo } from 'net'
import type { ContainerConfig, ContainerInfo } from './types'
import { BaseContainerClient } from './base-container-client'

vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: () => 'test-host-token',
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ enableToolSearch: true }),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))

class RunningPortClient extends BaseContainerClient {
  constructor(private readonly port: number) {
    super({ agentId: 'test-agent' } as ContainerConfig)
  }
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'running', port: this.port }
  }
}

describe('closeTrackedWebSocket on a CONNECTING socket', () => {
  let server: net.Server | undefined
  const held: net.Socket[] = []

  afterEach(async () => {
    for (const socket of held) socket.destroy()
    held.length = 0
    if (!server) return
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  })

  it('unsubscribe before open does not raise uncaughtException', async () => {
    server = net.createServer((socket) => {
      held.push(socket)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const client = new RunningPortClient(port)
    const { unsubscribe, ready } = client.subscribeToStream('sess-connecting', () => {})
    void ready.catch(() => {})

    const readyState = await Promise.race([
      ready.then(() => 'opened' as const, (error) => Promise.reject(error)),
      new Promise<'connecting'>((resolve) => setTimeout(() => resolve('connecting'), 50)),
    ])
    expect(readyState).toBe('connecting')

    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    try {
      unsubscribe()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
