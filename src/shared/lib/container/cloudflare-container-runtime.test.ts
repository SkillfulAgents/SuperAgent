import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: {}, enableToolSearch: true }),
}))

import { CloudflareContainerRuntimeClient } from './cloudflare-container-runtime'

const ENV = {
  CLOUDFLARE_CONTAINER_URL: 'http://agent-container.internal/',
  CLOUDFLARE_CONTAINER_HOST_URL: 'http://host.internal',
}

/** The deployment's side of the contract, in memory: one container per agent. */
function fakeDeployment(options: { running?: boolean; startStatus?: number } = {}) {
  const state = { running: options.running ?? false }
  const calls: string[] = []
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    if (url.pathname === '/_control/agent-1') return Response.json({ running: state.running })
    if (url.pathname === '/_control/agent-1/start') {
      if (options.startStatus) return new Response('no capacity', { status: options.startStatus })
      state.running = true
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/_control/agent-1/stop') {
      state.running = false
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/agent-1/health') {
      return state.running ? Response.json({ status: 'ok' }) : new Response(null, { status: 503 })
    }
    return new Response(null, { status: 404 })
  }))
  return { state, calls, bodies }
}

beforeEach(() => {
  Object.assign(process.env, ENV)
})

afterEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key]
  vi.unstubAllGlobals()
})

describe('CloudflareContainerRuntimeClient', () => {
  it('is eligible only when both URLs are set', () => {
    expect(CloudflareContainerRuntimeClient.isEligible()).toBe(true)
    delete process.env.CLOUDFLARE_CONTAINER_HOST_URL
    expect(CloudflareContainerRuntimeClient.isEligible()).toBe(false)
  })

  it('starts a stopped agent with its env, then waits for /health', async () => {
    const deployment = fakeDeployment()
    const client = new CloudflareContainerRuntimeClient({ agentId: 'agent-1', envVars: { NOTES_DIR: '/workspace/notes' } })

    await expect(client.start({ agentName: 'Researcher' })).resolves.toEqual({ status: 'running', port: 3000 })

    expect(deployment.calls.slice(0, 3)).toEqual(['GET /_control/agent-1', 'POST /_control/agent-1/start', 'GET /agent-1/health'])
    expect(deployment.bodies[0]).toMatchObject({
      env: { SUPERAGENT_AGENT_ID: 'agent-1', SUPERAGENT_AGENT_NAME: 'Researcher', NOTES_DIR: '/workspace/notes' },
    })
  })

  it('does not start an agent that is already running', async () => {
    const deployment = fakeDeployment({ running: true })
    const onAlreadyRunning = vi.fn()

    await new CloudflareContainerRuntimeClient({ agentId: 'agent-1' }).start({ onAlreadyRunning })

    expect(onAlreadyRunning).toHaveBeenCalledOnce()
    expect(deployment.calls).toEqual(['GET /_control/agent-1'])
  })

  it('stops the agent', async () => {
    const deployment = fakeDeployment({ running: true })
    const client = new CloudflareContainerRuntimeClient({ agentId: 'agent-1' })

    await expect(client.stop()).resolves.toEqual({ forceStopUsed: false, stopped: true })

    expect(deployment.calls).toEqual(['POST /_control/agent-1/stop'])
    await expect(client.getInfoFromRuntime()).resolves.toEqual({ status: 'stopped', port: null })
  })

  it('reports a refused start with the status and body the deployment sent', async () => {
    fakeDeployment({ startStatus: 503 })

    await expect(new CloudflareContainerRuntimeClient({ agentId: 'agent-1' }).start()).rejects.toThrow(
      'Cloudflare container POST /_control/agent-1/start failed: 503 no capacity',
    )
  })

  it('reaches the container and the host at the configured URLs', () => {
    const client = new CloudflareContainerRuntimeClient({ agentId: 'agent-1' })
    expect(client.getWebSocketBaseUrl(3000)).toBe('ws://agent-container.internal/agent-1')
    expect(client.getHostApiBaseUrl()).toBe('http://host.internal')
  })
})
