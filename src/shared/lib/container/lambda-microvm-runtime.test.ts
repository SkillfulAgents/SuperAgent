import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import net from 'net'
import { PassThrough } from 'stream'
import { WebSocketServer } from 'ws'

const sendMock = vi.fn()
const responses: Record<string, unknown> = {}

// Upstream transports are mocked so the proxy's real loopback server can be
// driven by real http/net clients while we capture what it forwards upstream.
const tlsConnectMock = vi.fn()
vi.mock('tls', () => ({
  default: { connect: (...a: unknown[]) => tlsConnectMock(...a) },
  connect: (...a: unknown[]) => tlsConnectMock(...a),
}))

vi.mock('@aws-sdk/client-lambda-microvms', () => {
  class RunMicrovmCommand { type = 'Run'; constructor(public input: unknown) {} }
  class GetMicrovmCommand { type = 'Get'; constructor(public input: unknown) {} }
  class TerminateMicrovmCommand { type = 'Terminate'; constructor(public input: unknown) {} }
  class CreateMicrovmAuthTokenCommand { type = 'Token'; constructor(public input: unknown) {} }
  return {
    LambdaMicrovmsClient: class { send = (cmd: { type: string }) => sendMock(cmd) },
    RunMicrovmCommand,
    GetMicrovmCommand,
    TerminateMicrovmCommand,
    CreateMicrovmAuthTokenCommand,
  }
})

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))
// Inert: the env builder reaches for the active provider; we don't assert its
// output here (that's the builder's concern), we only verify the runtime
// delivers the agent's own config.envVars through runHookPayload.
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))

const autoSleepTimeoutMinutes = vi.fn((): number | undefined => 30)
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: { autoSleepTimeoutMinutes: autoSleepTimeoutMinutes() }, enableToolSearch: true }),
}))

import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
import {
  LambdaMicroVmRuntimeClient,
  LocalAuthForwardProxy,
  MICROVM_STREAM_KEEPALIVE_MS,
  attachMicrovmUpstreamKeepalive,
  createMicrovmWebSocketPingFrame,
  resetMicrovmRuntimeForTests,
  resolveMicrovmRuntimeConfigOrNull,
  isMicrovmRuntimeConfigured,
  getMicrovmRuntimeConfig,
} from './lambda-microvm-runtime'
import { readBootstrapEnv, resetBootstrapEnvStoreForTests } from './agent-bootstrap-env-store'

const REQUIRED_ENV = {
  MICROVM_AWS_REGION: 'us-east-2',
  MICROVM_AGENT_IMAGE_ARN: 'arn:img',
  MICROVM_EXECUTION_ROLE_ARN: 'arn:exec',
  MICROVM_EGRESS_CONNECTOR_ARN: 'arn:egress',
}
const FULL_ENV = { ...REQUIRED_ENV, HOST_PUBLIC_URL: 'https://host.example' }

const TOUCHED = [
  ...Object.keys(FULL_ENV),
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'MICROVM_AGENT_IMAGE_VERSION', 'MICROVM_INGRESS_CONNECTOR_ARN',
  'MICROVM_AGENT_PORT', 'MICROVM_MAX_DURATION_SECONDS', 'MICROVM_LOG_GROUP',
  'MICROVM_FS_ID', 'MICROVM_ACCESS_POINT', 'MICROVM_MOUNT_TARGET_IP', 'ECS_CONTAINER_METADATA_URI_V4', 'PORT',
  'MICROVM_PROXY_URL', 'MICROVM_PROXY_TOKEN',
]

beforeEach(() => {
  for (const k of TOUCHED) delete process.env[k]
  for (const k in responses) delete responses[k]
  autoSleepTimeoutMinutes.mockReturnValue(30)
  sendMock.mockReset()
  tlsConnectMock.mockReset()
  sendMock.mockImplementation(async (cmd: { type: string }) => {
    if (cmd.type === 'Run') return { microvmId: 'mvm-1', endpoint: 'ep.lambda-microvm.aws' }
    if (cmd.type === 'Get') {
      return { state: responses.getState ?? 'RUNNING', stateReason: responses.getStateReason }
    }
    if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
    return {}
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response))
  resetMicrovmRuntimeForTests()
  resetBootstrapEnvStoreForTests()
})

afterEach(() => {
  for (const k of TOUCHED) delete process.env[k]
  resetMicrovmRuntimeForTests()
  vi.unstubAllGlobals()
})

describe('microvm runtime config', () => {
  it('returns null and isConfigured=false when required env is absent', () => {
    expect(resolveMicrovmRuntimeConfigOrNull()).toBeNull()
    expect(isMicrovmRuntimeConfigured()).toBe(false)
  })

  it('drops the config when one required field is missing', () => {
    Object.assign(process.env, REQUIRED_ENV)
    delete process.env.MICROVM_EGRESS_CONNECTOR_ARN
    expect(resolveMicrovmRuntimeConfigOrNull()).toBeNull()
  })

  it('parses a fully configured env and applies defaults', () => {
    Object.assign(process.env, REQUIRED_ENV)
    const config = getMicrovmRuntimeConfig()
    expect(config.region).toBe('us-east-2')
    expect(config.imageArn).toBe('arn:img')
    expect(config.agentPort).toBe(3000)
    // Lifetime defaults to the AWS 8h cap.
    expect(config.maxDurationSeconds).toBe(28_800)
  })

  it('defaults the ingress connector to the AWS well-known ALL_INGRESS for the region', () => {
    Object.assign(process.env, REQUIRED_ENV)
    expect(getMicrovmRuntimeConfig().ingressConnectorArn).toBe(
      'arn:aws:lambda:us-east-2:aws:network-connector:aws-network-connector:ALL_INGRESS',
    )
  })

  it('honors an explicit ingress connector', () => {
    Object.assign(process.env, REQUIRED_ENV, { MICROVM_INGRESS_CONNECTOR_ARN: 'arn:custom:ingress' })
    expect(getMicrovmRuntimeConfig().ingressConnectorArn).toBe('arn:custom:ingress')
  })

  it('falls back to AWS_REGION then AWS_DEFAULT_REGION', () => {
    Object.assign(process.env, REQUIRED_ENV)
    delete process.env.MICROVM_AWS_REGION
    process.env.AWS_DEFAULT_REGION = 'eu-west-1'
    expect(getMicrovmRuntimeConfig().region).toBe('eu-west-1')
  })

  it('coerces numeric overrides from strings', () => {
    Object.assign(process.env, REQUIRED_ENV, {
      MICROVM_AGENT_PORT: '8080',
      MICROVM_MAX_DURATION_SECONDS: '600',
    })
    const config = getMicrovmRuntimeConfig()
    expect(config.agentPort).toBe(8080)
    expect(config.maxDurationSeconds).toBe(600)
  })

  it('memoizes the resolved config across calls', () => {
    Object.assign(process.env, REQUIRED_ENV)
    expect(resolveMicrovmRuntimeConfigOrNull()).toBe(resolveMicrovmRuntimeConfigOrNull())
  })

  it('getMicrovmRuntimeConfig throws when unconfigured', () => {
    expect(() => getMicrovmRuntimeConfig()).toThrow(/not configured/)
  })
})

describe('LambdaMicroVmRuntimeClient eligibility', () => {
  it('isEligible only when runtime env is configured', () => {
    Object.assign(process.env, FULL_ENV)
    resetMicrovmRuntimeForTests()
    expect(LambdaMicroVmRuntimeClient.isEligible()).toBe(true)
    for (const k of TOUCHED) delete process.env[k]
    resetMicrovmRuntimeForTests()
    expect(LambdaMicroVmRuntimeClient.isEligible()).toBe(false)
  })

  it('isAvailable requires HOST_PUBLIC_URL', async () => {
    Object.assign(process.env, FULL_ENV)
    resetMicrovmRuntimeForTests()
    expect(await LambdaMicroVmRuntimeClient.isAvailable()).toBe(true)
    delete process.env.HOST_PUBLIC_URL
    expect(await LambdaMicroVmRuntimeClient.isAvailable()).toBe(false)
  })
})

describe('LambdaMicroVmRuntimeClient host API base URL', () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV)
    resetMicrovmRuntimeForTests()
  })

  it('falls back to HOST_PUBLIC_URL when ECS metadata is unavailable', async () => {
    process.env.HOST_PUBLIC_URL = 'https://host.example/'
    await expect(new LambdaMicroVmRuntimeClient({ agentId: 'agent-url' }).getHostApiBaseUrl()).resolves.toBe('https://host.example')
  })

  it('uses the ECS task private IP and host-app port when metadata is available', async () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://metadata.local/v4/container'
    process.env.PORT = '3456'
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === 'http://metadata.local/v4/container') {
        return {
          ok: true,
          json: async () => ({ Networks: [{ IPv4Addresses: ['10.0.12.34'] }] }),
        } as Response
      }
      return { ok: true } as Response
    })

    await expect(new LambdaMicroVmRuntimeClient({ agentId: 'agent-url' }).getHostApiBaseUrl()).resolves.toBe('http://10.0.12.34:3456')
  })
})

describe('LambdaMicroVmRuntimeClient lifecycle', () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV)
    resetMicrovmRuntimeForTests()
  })

  function newClient(opts?: { withRestartAgent?: boolean }) {
    // envVars is the public seam: whatever the agent is configured with must
    // arrive inside runHookPayload.env, regardless of how the env is built.
    // Replace requires restartAgent (prod: ContainerManager); unit tests stub it.
    let client!: LambdaMicroVmRuntimeClient
    client = new LambdaMicroVmRuntimeClient({
      agentId: 'agent-xyz',
      envVars: { FOO: 'bar' },
      ...(opts?.withRestartAgent === false
        ? {}
        : {
            restartAgent: async () => {
              await client.start()
            },
          }),
    })
    return client
  }

  function refusedConnectError() {
    return new Error('Failed to start session - unable to connect to the agent', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:4000'),
    })
  }

  it('start runs a MicroVM with image/role/connectors and becomes healthy', async () => {
    const info = await newClient().start()
    expect(info.status).toBe('running')
    expect(typeof info.port).toBe('number')
    const runCall = sendMock.mock.calls.find((c) => c[0].type === 'Run')
    expect(runCall).toBeTruthy()
    const input = runCall![0].input
    expect(input.imageIdentifier).toBe('arn:img')
    expect(input.executionRoleArn).toBe('arn:exec')
    expect(input.egressNetworkConnectors).toEqual(['arn:egress'])
    expect(input.idlePolicy.autoResumeEnabled).toBe(false)
    // AWS idle capped at lifetime — host auto-sleep terminates; no suspend path.
    expect(input.idlePolicy.maxIdleDurationSeconds).toBe(28_800)
    expect(input.idlePolicy.suspendedDurationSeconds).toBe(1)
    expect(input.maximumDurationInSeconds).toBe(28_800)
    expect(typeof input.clientToken).toBe('string')
    expect(input.clientToken.length).toBeGreaterThan(0)
    const payload = JSON.parse(input.runHookPayload)
    // Env no longer rides the payload (4096 cap); only a small bootstrap credential does.
    expect(payload.env).toBeUndefined()
    expect(payload.bootstrap.url).toBe('https://host.example/api/agent-bootstrap/agent-xyz/env')
    expect(payload.mount).toBeUndefined() // no mount configured here
    // The full env is stashed host-side for the VM to fetch at boot.
    expect(readBootstrapEnv('agent-xyz')).toMatchObject({ FOO: 'bar' })
  })

  it('routes MicroVM ops through the security service (not the SDK) when MICROVM_PROXY_URL + TOKEN are set', async () => {
    process.env.MICROVM_PROXY_URL = 'https://mvm.internal'
    process.env.MICROVM_PROXY_TOKEN = 'org-a-token'
    resetMicrovmRuntimeForTests()

    const runBodies: Array<Record<string, unknown>> = []
    vi.mocked(fetch).mockImplementation(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      if (url === 'https://mvm.internal/microvm/run') {
        runBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return { ok: true, status: 201, json: async () => ({ microvmId: 'mvm-svc', endpoint: 'ep.svc' }) } as unknown as Response
      }
      if (url.startsWith('https://mvm.internal/microvm/mvm-svc')) {
        return { ok: true, status: 200, json: async () => ({ state: 'RUNNING', endpoint: 'ep.svc' }) } as unknown as Response
      }
      return { ok: true } as Response // waitForHealthy /health + host talk-back
    })

    await newClient().start()

    // Went through the service, never the SDK.
    expect(sendMock.mock.calls.find((c) => c[0].type === 'Run')).toBeFalsy()
    expect(runBodies).toHaveLength(1)
    // Injected-by-service fields are never sent; egressConnectorArn goes as a
    // hint the service verifies against this org's connector name.
    expect(runBodies[0].egressNetworkConnectors).toBeUndefined()
    expect(runBodies[0].executionRoleArn).toBeUndefined()
    expect(runBodies[0].imageIdentifier).toBeUndefined()
    expect(runBodies[0].egressConnectorArn).toBe('arn:egress')
    const runCall = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === 'https://mvm.internal/microvm/run')!
    const headers = (runCall[1]?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer org-a-token')
  })

  it('talks to AWS directly (SDK path) when MICROVM_PROXY_URL is unset — the default/OSS mode', async () => {
    // FULL_ENV sets no proxy vars, so this is the backward-compatible default.
    await newClient().start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes('/microvm/'))).toBe(false)
  })

  it('fails loudly when MICROVM_PROXY_URL is set but MICROVM_PROXY_TOKEN is missing (no silent SDK fallback)', async () => {
    process.env.MICROVM_PROXY_URL = 'https://mvm.internal'
    delete process.env.MICROVM_PROXY_TOKEN
    resetMicrovmRuntimeForTests()

    await expect(newClient().start()).rejects.toThrow(/MICROVM_PROXY_TOKEN/)
    // Must never have silently fallen back to the SDK (an opaque AccessDenied in prod).
    expect(sendMock.mock.calls.find((c) => c[0].type === 'Run')).toBeFalsy()
  })

  it('puts the direct private host-app URL in the bootstrap payload when ECS metadata is available', async () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://metadata.local/v4/container'
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === 'http://metadata.local/v4/container') {
        return {
          ok: true,
          json: async () => ({ Networks: [{ IPv4Addresses: ['10.0.12.34'] }] }),
        } as Response
      }
      return { ok: true } as Response
    })

    await newClient().start()
    const input = sendMock.mock.calls.find((c) => c[0].type === 'Run')![0].input
    expect(JSON.parse(input.runHookPayload).bootstrap.url).toBe('http://10.0.12.34:3000/api/agent-bootstrap/agent-xyz/env')
  })

  it('the bootstrap credential carries the agent PROXY_TOKEN for the boot fetch', async () => {
    const client = new LambdaMicroVmRuntimeClient({ agentId: 'agent-tok', envVars: { PROXY_TOKEN: 'synth_abc' } })
    await client.start()
    const input = sendMock.mock.calls.find((c) => c[0].type === 'Run')![0].input
    expect(JSON.parse(input.runHookPayload).bootstrap.token).toBe('synth_abc')
  })

  it('uses a unique clientToken per start (fixed tokens collide on idempotency → InternalFailure)', async () => {
    await new LambdaMicroVmRuntimeClient({ agentId: 'a' }).start()
    resetMicrovmRuntimeForTests()
    Object.assign(process.env, FULL_ENV)
    await new LambdaMicroVmRuntimeClient({ agentId: 'a' }).start()
    const tokens = sendMock.mock.calls.filter((c) => c[0].type === 'Run').map((c) => c[0].input.clientToken)
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).not.toBe(tokens[1])
  })

  it('mints a fresh hookToken per start and never leaks it into the agent env', async () => {
    await new LambdaMicroVmRuntimeClient({ agentId: 'a', envVars: { FOO: 'bar' } }).start()
    resetMicrovmRuntimeForTests()
    Object.assign(process.env, FULL_ENV)
    await new LambdaMicroVmRuntimeClient({ agentId: 'a', envVars: { FOO: 'bar' } }).start()
    const tokens = sendMock.mock.calls
      .filter((c) => c[0].type === 'Run')
      .map((c) => JSON.parse(c[0].input.runHookPayload).hookToken)
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toBeTruthy()
    expect(tokens[0]).not.toBe(tokens[1])
    // The token rides only the run payload, never the agent's fetched env.
    expect(readBootstrapEnv('a')).not.toHaveProperty('hookToken')
  })

  it('includes the workspace mount in runHookPayload when fs/ap/mtip are configured', async () => {
    Object.assign(process.env, {
      MICROVM_FS_ID: 'fs-1',
      MICROVM_ACCESS_POINT: 'fsap-1',
      MICROVM_MOUNT_TARGET_IP: '10.0.0.5',
    })
    resetMicrovmRuntimeForTests()
    await newClient().start()
    const input = sendMock.mock.calls.find((c) => c[0].type === 'Run')![0].input
    const payload = JSON.parse(input.runHookPayload)
    expect(payload.bootstrap.url).toContain('/api/agent-bootstrap/agent-xyz/env')
    expect(payload.mount).toEqual({ fsId: 'fs-1', accessPoint: 'fsap-1', mountTargetIp: '10.0.0.5', subPath: 'agents/agent-xyz/workspace' })
  })

  it('omits mount when the mount params are not fully configured', async () => {
    Object.assign(process.env, { MICROVM_FS_ID: 'fs-1' }) // accessPoint/mtip missing
    resetMicrovmRuntimeForTests()
    await newClient().start()
    const input = sendMock.mock.calls.find((c) => c[0].type === 'Run')![0].input
    expect(JSON.parse(input.runHookPayload).mount).toBeUndefined()
  })

  it('getInfoFromRuntime reports running with the proxy port after start', async () => {
    const client = newClient()
    await client.start()
    const info = await client.getInfoFromRuntime()
    expect(info.status).toBe('running')
    expect(typeof info.port).toBe('number')
  })

  it('getInfoFromRuntime reports stopped before any start (no state)', async () => {
    expect(await newClient().getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
  })

  it('getInfoFromRuntime treats SUSPENDED as stopped and terminates the leftover VM', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'SUSPENDED'
    sendMock.mockClear()
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(true)
  })

  it('getInfoFromRuntime reports stopped when the VM is TERMINATED and cleans up local state', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'TERMINATED'
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })

    // Terminal state must drop local state (mirror NotFound): a subsequent start()
    // re-runs a fresh VM rather than reusing the dead one's proxy.
    responses.getState = 'RUNNING'
    sendMock.mockClear()
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(true)
  })

  it('getInfoFromRuntime keeps last known running state on a transient (non-NotFound) error', async () => {
    const client = newClient()
    await client.start()
    const port = (await client.getInfoFromRuntime()).port

    // A throttling/network blip must not be reported as stopped (which would orphan
    // the live VM when start()/ensureRunning react to it).
    sendMock.mockImplementationOnce(async () => { throw new Error('ThrottlingException') })
    const info = await client.getInfoFromRuntime()
    expect(info.status).toBe('running')
    expect(info.port).toBe(port)

    // State is retained: the next start() short-circuits (no new RunMicrovm).
    sendMock.mockClear()
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
  })

  it('start stops the prior proxy across a terminate→restart cycle (no leaked listener)', async () => {
    const stopSpy = vi.spyOn(LocalAuthForwardProxy.prototype, 'stop')
    const client = newClient()
    await client.start()
    expect((await client.getInfoFromRuntime()).status).toBe('running')

    // VM dies → getInfo cleans up the old proxy; the next request restarts it.
    responses.getState = 'TERMINATED'
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
    expect(stopSpy).toHaveBeenCalled() // old loopback server was closed, not leaked

    responses.getState = 'RUNNING'
    await client.start()
    const info = await client.getInfoFromRuntime()
    expect(info.status).toBe('running')
    expect(typeof info.port).toBe('number')
    stopSpy.mockRestore()
  })

  it('background auto-sleep (escalateToForceStop:false) terminates like other runners', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    await client.stop({ escalateToForceStop: false })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Suspend')).toBe(false)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(true)
  })

  it('a plain stop() terminates (no suspend / warm resume)', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    const result = await client.stop()

    expect(result).toEqual({ forceStopUsed: false, stopped: true })
    const terminateCall = sendMock.mock.calls.find((c) => c[0].type === 'Terminate')
    expect(terminateCall![0].input).toEqual({ microvmIdentifier: 'mvm-1' })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Suspend')).toBe(false)

    // State is cleared: a subsequent start() runs a fresh MicroVM.
    sendMock.mockClear()
    responses.getState = 'RUNNING'
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(true)
  })

  it('a plain stop() is a no-op terminate when already gone', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'TERMINATED'
    // Drop local state as if getInfo already cleaned up.
    await client.getInfoFromRuntime()
    sendMock.mockClear()
    await client.stop()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Suspend')).toBe(false)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
  })

  it('start is a no-op when the agent is already running', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
  })

  it('createSession replaces after connect-refused when the generation is TERMINATING', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start({ envVars: { FOO: 'bar' } })
    sendMock.mockClear()

    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Run') {
        runCount++
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-new-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate
      .mockImplementationOnce(async () => {
        responses.getState = 'TERMINATING'
        throw refusedConnectError()
      })
      .mockResolvedValueOnce({ id: 'sess-1' } as never)

    await expect(client.createSession({ initialMessage: 'hi' })).resolves.toEqual({ id: 'sess-1' })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(true)
    expect(runCount).toBe(1)
    expect(superCreate).toHaveBeenCalledTimes(2)
    superCreate.mockRestore()
  })

  // getPortOrThrow → getInfoFromRuntime CAS-drops TERMINATING before the catch;
  // without the installedId snapshot, observeDeadGeneration sees nothing and we
  // never replace — the primary scenario this PR exists to fix.
  it('createSession replaces when getPortOrThrow wiped a TERMINATING generation', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Run') {
        runCount++
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-wipe-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    responses.getState = 'TERMINATING'
    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate.mockImplementation(async function (this: LambdaMicroVmRuntimeClient) {
      const info = await this.getInfoFromRuntime()
      if (info.status !== 'running' || !info.port) throw new Error('Container is not running')
      return { id: 'sess-real' } as never
    })

    await expect(client.createSession({ initialMessage: 'hi' })).resolves.toEqual({ id: 'sess-real' })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(true)
    expect(runCount).toBe(1)
    expect(superCreate).toHaveBeenCalledTimes(2)
    superCreate.mockRestore()
  })

  it('createSession replaces after connect-refused when the generation is TERMINATED', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Run') {
        runCount++
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-retry-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate
      .mockImplementationOnce(async () => {
        responses.getState = 'TERMINATED'
        throw refusedConnectError()
      })
      .mockResolvedValueOnce({ id: 'sess-2' } as never)

    await expect(client.createSession({ initialMessage: 'hi' })).resolves.toEqual({ id: 'sess-2' })
    expect(runCount).toBe(1)
    expect(superCreate).toHaveBeenCalledTimes(2)
    expect(addErrorBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'post_create_unreachable',
          classification: 'runtime_lost',
          state: 'TERMINATED',
        }),
      }),
    )
    superCreate.mockRestore()
  })

  it('replaceGeneration breadcrumb classifies max-lifetime stateReason', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    vi.mocked(addErrorBreadcrumb).mockClear()

    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Run') {
        responses.getState = 'RUNNING'
        delete responses.getStateReason
        return { microvmId: 'mvm-retry-8h', endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') {
        return { state: responses.getState ?? 'RUNNING', stateReason: responses.getStateReason }
      }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate
      .mockImplementationOnce(async () => {
        responses.getState = 'TERMINATED'
        responses.getStateReason = 'MicroVM exceeded maximum lifetime.'
        throw refusedConnectError()
      })
      .mockResolvedValueOnce({ id: 'sess-8h' } as never)

    await expect(client.createSession({ initialMessage: 'hi' })).resolves.toEqual({ id: 'sess-8h' })
    expect(addErrorBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          classification: 'max_lifetime',
          state: 'TERMINATED',
          stateReason: 'MicroVM exceeded maximum lifetime.',
        }),
      }),
    )
    superCreate.mockRestore()
  })

  it('createSession does not resurrect when connect-refused but generation is still RUNNING', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    responses.getState = 'RUNNING'

    const superCreate = vi
      .spyOn(BaseContainerClient.prototype, 'createSession')
      .mockRejectedValue(refusedConnectError())

    await expect(client.createSession({ initialMessage: 'hi' })).rejects.toThrow(/unable to connect/)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
    expect(superCreate).toHaveBeenCalledTimes(1)
    superCreate.mockRestore()
  })

  it('replace without restartAgent throws instead of booting an env-less VM', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient({ withRestartAgent: false })
    await client.start()
    sendMock.mockClear()

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate.mockImplementationOnce(async () => {
      responses.getState = 'TERMINATED'
      throw refusedConnectError()
    })

    await expect(client.createSession({ initialMessage: 'hi' })).rejects.toThrow(/restartAgent is required/)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
    superCreate.mockRestore()
  })

  it('createSession does not replace on reset/timeout-shaped unable-to-connect (ambiguous delivery)', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    responses.getState = 'RUNNING'

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    for (const cause of [
      new Error('read ECONNRESET'),
      new Error('connect ETIMEDOUT 10.0.0.1:3000'),
      new Error('fetch failed'),
    ]) {
      // Keep generation RUNNING so observeDeadGeneration returns null.
      responses.getState = 'RUNNING'
      superCreate.mockReset()
      superCreate.mockRejectedValueOnce(
        new Error('Failed to start session - unable to connect to the agent', { cause }),
      )
      await expect(client.createSession({ initialMessage: 'hi' })).rejects.toThrow(/unable to connect/)
      expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
      expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
      expect(superCreate).toHaveBeenCalledTimes(1)
      sendMock.mockClear()
    }
    superCreate.mockRestore()
  })

  it('createSession does not replace on a generic create failure while the VM is RUNNING', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    responses.getState = 'RUNNING'

    const superCreate = vi
      .spyOn(BaseContainerClient.prototype, 'createSession')
      .mockRejectedValue(new Error('Failed to create session: boom'))

    await expect(client.createSession({ initialMessage: 'hi' })).rejects.toThrow(/boom/)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
    expect(superCreate).toHaveBeenCalledTimes(1)
    superCreate.mockRestore()
  })

  it('createSession does not replace on timeout even if the generation later looks dead', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate.mockImplementationOnce(async () => {
      responses.getState = 'TERMINATED'
      throw new Error(
        'Failed to start session - request timed out. This may be due to network issues or the AI service being slow. Please try again.',
      )
    })

    await expect(client.createSession({ initialMessage: 'hi' })).rejects.toThrow(/timed out/)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
    expect(superCreate).toHaveBeenCalledTimes(1)
    superCreate.mockRestore()
  })

  it('concurrent createSession on a dead generation only RunMicrovm once', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Run') {
        runCount++
        await new Promise((r) => setTimeout(r, 20))
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-once-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate.mockImplementation(async () => {
      if (responses.getState === 'TERMINATING' || responses.getState === 'TERMINATED') {
        throw refusedConnectError()
      }
      return { id: 'sess-x' } as never
    })
    responses.getState = 'TERMINATING'

    await Promise.all([
      client.createSession({ initialMessage: 'a' }),
      client.createSession({ initialMessage: 'b' }),
    ])
    expect(runCount).toBe(1)
    // Two refused attempts + two successful retries after shared replace.
    expect(superCreate).toHaveBeenCalledTimes(4)
    superCreate.mockRestore()
  })

  it('replace Terminate await does not wipe a newer generation installed mid-flight', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    let releaseTerminate: (() => void) | undefined
    const terminateGate = new Promise<void>((resolve) => {
      releaseTerminate = resolve
    })
    let terminateStarted!: () => void
    const terminateStartedP = new Promise<void>((resolve) => {
      terminateStarted = resolve
    })

    const client = newClient()
    await client.start()
    const oldId = 'mvm-1'
    sendMock.mockClear()

    const terminateIds: string[] = []
    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string; input?: { microvmIdentifier?: string } }) => {
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Run') {
        runCount++
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-cas-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Terminate') {
        const id = String(cmd.input?.microvmIdentifier ?? '')
        terminateIds.push(id)
        if (id === oldId) {
          terminateStarted()
          await terminateGate
        }
        return {}
      }
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate
      .mockImplementationOnce(async () => {
        responses.getState = 'TERMINATING'
        throw refusedConnectError()
      })
      .mockResolvedValue({ id: 'sess-cas-teardown' } as never)

    const createPromise = client.createSession({ initialMessage: 'hi' })
    await terminateStartedP
    // Install a healthy generation while Terminate(old) is still awaiting.
    client.stopSync()
    responses.getState = 'RUNNING'
    await client.start()
    const freshId = `mvm-cas-${runCount}`
    releaseTerminate?.()
    await createPromise

    expect(terminateIds).toContain(oldId)
    expect(terminateIds).not.toContain(freshId)
    const info = await client.getInfoFromRuntime()
    expect(info.status).toBe('running')
    expect(runCount).toBe(1)
    superCreate.mockRestore()
  })

  it('stop() teardown must not wipe a generation installed during TerminateMicrovm', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    let releaseTerminate!: () => void
    const gate = new Promise<void>((r) => {
      releaseTerminate = r
    })
    let terminateStarted!: () => void
    const terminateStartedP = new Promise<void>((r) => {
      terminateStarted = r
    })

    const terminateIds: string[] = []
    let gatedOnce = false
    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string; input?: { microvmIdentifier?: string } }) => {
      if (cmd.type === 'Run') {
        runCount++
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-probe-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Terminate') {
        terminateIds.push(String(cmd.input?.microvmIdentifier ?? ''))
        if (!gatedOnce) {
          gatedOnce = true
          terminateStarted()
          await gate
        }
        return {}
      }
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const stopPromise = client.stop()
    await terminateStartedP
    responses.getState = 'TERMINATING'
    await client.getInfoFromRuntime()
    responses.getState = 'RUNNING'
    await client.start()
    releaseTerminate()
    await stopPromise

    responses.getState = 'RUNNING'
    expect((await client.getInfoFromRuntime()).status).toBe('running')
    expect(terminateIds).toContain('mvm-1')
    expect(terminateIds).not.toContain('mvm-probe-1')
  })

  it('stale dead-generation observation does not terminate a newer healthy generation', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    let releaseGet: (() => void) | undefined
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve
    })
    let observeGetStarted!: () => void
    const observeGetStartedP = new Promise<void>((resolve) => {
      observeGetStarted = resolve
    })

    const client = newClient()
    await client.start()
    sendMock.mockClear()

    const terminateIds: string[] = []
    let runCount = 0
    let gated = false
    sendMock.mockImplementation(async (cmd: { type: string; input?: { microvmIdentifier?: string } }) => {
      if (cmd.type === 'Get') {
        // Gate only the first Get (observeDeadGeneration on mvm-1).
        if (!gated) {
          gated = true
          observeGetStarted()
          await getGate
          return { state: 'TERMINATING' }
        }
        return { state: responses.getState ?? 'RUNNING' }
      }
      if (cmd.type === 'Run') {
        runCount++
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-fresh-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Terminate') {
        terminateIds.push(String(cmd.input?.microvmIdentifier ?? ''))
        return {}
      }
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate
      .mockRejectedValueOnce(refusedConnectError())
      .mockResolvedValue({ id: 'sess-cas' } as never)

    const createPromise = client.createSession({ initialMessage: 'hi' })
    await observeGetStartedP
    // Swap in a healthy generation while observe is still awaiting GetMicrovm.
    client.stopSync()
    responses.getState = 'RUNNING'
    await client.start()
    releaseGet?.()
    await createPromise

    expect(terminateIds).not.toContain('mvm-fresh-1')
    expect(runCount).toBe(1)
    superCreate.mockRestore()
  })

  it('restartAgent single-flight prevents duplicate RunMicrovm when replace races start', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    let inflight: Promise<void> | null = null
    let client!: LambdaMicroVmRuntimeClient
    const restartAgent = async () => {
      if (inflight) return inflight
      inflight = client.start().then(() => undefined).finally(() => {
        inflight = null
      })
      return inflight
    }
    client = new LambdaMicroVmRuntimeClient({
      agentId: 'agent-xyz',
      envVars: { FOO: 'bar' },
      restartAgent,
    })
    await client.start()
    sendMock.mockClear()

    let runCount = 0
    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Run') {
        runCount++
        await new Promise((r) => setTimeout(r, 40))
        responses.getState = 'RUNNING'
        return { microvmId: `mvm-race-${runCount}`, endpoint: 'ep.lambda-microvm.aws' }
      }
      if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi.spyOn(BaseContainerClient.prototype, 'createSession')
    superCreate
      .mockImplementationOnce(async () => {
        responses.getState = 'TERMINATING'
        throw refusedConnectError()
      })
      .mockResolvedValue({ id: 'sess-race' } as never)

    // createSession replaces then restartAgent; a concurrent ensureRunning-style
    // restart shares the same single-flight lock (prod: ContainerManager.startingAgents).
    await Promise.all([
      client.createSession({ initialMessage: 'a' }),
      (async () => {
        await new Promise((r) => setTimeout(r, 5))
        await restartAgent()
      })(),
    ])
    expect(runCount).toBe(1)
    superCreate.mockRestore()
  })

  it('throttled GetMicrovm after connect-refused does not replace', async () => {
    const { BaseContainerClient } = await import('./base-container-client')
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Get') throw new Error('ThrottlingException')
      if (cmd.type === 'Run') return { microvmId: 'mvm-should-not', endpoint: 'ep.lambda-microvm.aws' }
      if (cmd.type === 'Terminate') return {}
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })

    const superCreate = vi
      .spyOn(BaseContainerClient.prototype, 'createSession')
      .mockRejectedValue(refusedConnectError())

    await expect(client.createSession({ initialMessage: 'hi' })).rejects.toThrow(/unable to connect/)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
    superCreate.mockRestore()
  })
})

describe('LocalAuthForwardProxy', () => {
  let capturedRequest: { host?: string; path?: string; headers?: Record<string, string>; timeout?: number }
  const proxies: LocalAuthForwardProxy[] = []

  type H2Stream = PassThrough & { setTimeout: (ms: number, cb?: () => void) => void }
  type H2Handler = (headers: Record<string, string>, stream: H2Stream) => void

  function h2Respond(stream: H2Stream, status: number, body: string) {
    if (body) stream.push(Buffer.from(body))
    process.nextTick(() => {
      stream.emit('response', { ':status': status })
      stream.push(null)
    })
  }

  function mockH2Session(handler: H2Handler) {
    return {
      closed: false,
      destroyed: false,
      request(headers: Record<string, string>) {
        const stream = new PassThrough() as H2Stream
        stream.setTimeout = (ms: number) => {
          capturedRequest = { ...capturedRequest, timeout: ms }
        }
        handler(headers, stream)
        return stream
      },
      destroy() {
        this.destroyed = true
        this.closed = true
      },
      close() {
        this.closed = true
      },
      on() { return this },
      off() { return this },
      once(ev: string, cb: () => void) {
        if (ev === 'connect') cb()
        return this
      },
    }
  }

  let http2ConnectImpl: ((...args: unknown[]) => ReturnType<typeof mockH2Session>) | undefined
  let http2ConnectCalls = 0

  function installH2(handler: H2Handler) {
    http2ConnectCalls = 0
    http2ConnectImpl = () => {
      http2ConnectCalls++
      return mockH2Session(handler)
    }
  }

  beforeEach(() => {
    capturedRequest = {}
    installH2((headers, stream) => {
      capturedRequest = {
        host: String(headers[':authority'] ?? ''),
        path: String(headers[':path'] ?? ''),
        headers: { ...headers, host: String(headers[':authority'] ?? '') },
      }
      h2Respond(stream, 200, 'UPSTREAM_OK')
    })
  })

  afterEach(() => {
    for (const p of proxies.splice(0)) p.stop()
  })

  function makeProxy(mintToken: () => Promise<Record<string, string>>) {
    const proxy = new LocalAuthForwardProxy({
      endpoint: 'mvm.lambda-microvm.aws',
      agentPort: 3000,
      mintToken,
      http2Connect: http2ConnectImpl as ConstructorParameters<typeof LocalAuthForwardProxy>[0]['http2Connect'],
    })
    proxies.push(proxy)
    return proxy
  }

  function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('injects auth + proxy-port headers, sets upstream host, and drops hop-by-hop headers', async () => {
    const proxy = makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok1' }))
    const port = await proxy.start()
    const res = await httpGet(port, '/sessions', { connection: 'keep-alive', te: 'trailers', 'x-custom': 'v' })
    expect(res.body).toBe('UPSTREAM_OK')
    expect(capturedRequest.host).toBe('mvm.lambda-microvm.aws')
    expect(capturedRequest.path).toBe('/sessions')
    expect(capturedRequest.headers!['X-aws-proxy-auth']).toBe('tok1')
    expect(capturedRequest.headers!['x-aws-proxy-port']).toBe('3000')
    expect(capturedRequest.headers!.host).toBe('mvm.lambda-microvm.aws')
    expect(capturedRequest.headers!['x-custom']).toBe('v')
    expect(capturedRequest.headers!.connection).toBeUndefined()
    expect(capturedRequest.headers!.te).toBeUndefined()
    expect(capturedRequest.headers!['x-aws-proxy-force-h2']).toBeUndefined()
    expect(capturedRequest.timeout).toBe(30_000)
  })

  it('caches the auth token across requests (mints once)', async () => {
    const mint = vi.fn(async () => ({ 'X-aws-proxy-auth': 'tok' }))
    const port = await makeProxy(mint).start()
    await httpGet(port, '/a')
    await httpGet(port, '/b')
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent token refreshes (mints once)', async () => {
    const mint = vi.fn(() => new Promise<Record<string, string>>((r) => setTimeout(() => r({ 'X-aws-proxy-auth': 'tok' }), 20)))
    const port = await makeProxy(mint).start()
    await Promise.all([httpGet(port, '/a'), httpGet(port, '/b'), httpGet(port, '/c')])
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('returns 502 when minting the auth token fails', async () => {
    const port = await makeProxy(async () => { throw new Error('token unavailable') }).start()
    const res = await httpGet(port, '/sessions')
    expect(res.status).toBe(502)
  })

  it('forwards WebSocket upgrades to TLS upstream with sec-websocket + injected auth headers', async () => {
    let capturedTls: { host?: string } = {}
    let written = ''
    const ready = new Promise<void>((resolve) => {
      tlsConnectMock.mockImplementation((opts: { host?: string }, cb: () => void) => {
        capturedTls = opts
        const sock = new PassThrough()
        sock.on('data', (d: Buffer) => {
          written += d.toString()
          if (written.includes('\r\n\r\n')) resolve()
        })
        process.nextTick(cb)
        return sock
      })
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tokws' })).start()
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(
        'GET /sessions/s1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: thekey\r\nSec-WebSocket-Version: 13\r\n' +
          'x-superagent-host-token: hostc_secret\r\n\r\n',
      )
    })
    await ready
    client.destroy()
    expect(capturedTls.host).toBe('mvm.lambda-microvm.aws')
    expect(written).toContain('GET /sessions/s1/stream HTTP/1.1')
    expect(written.toLowerCase()).toContain('sec-websocket-key: thekey')
    expect(written.toLowerCase()).toContain('x-aws-proxy-auth: tokws')
    expect(written.toLowerCase()).toContain('x-aws-proxy-port: 3000')
    // Host→agent auth must survive the upgrade pipe (HTTP path already forwards it).
    expect(written.toLowerCase()).toContain('x-superagent-host-token: hostc_secret')
  })

  it('sets an idle timeout on the upstream request to guard against a silent hang', async () => {
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    await httpGet(port, '/sessions')
    expect(typeof (capturedRequest as { timeout?: number }).timeout).toBe('number')
    expect((capturedRequest as { timeout?: number }).timeout!).toBeGreaterThan(0)
  })

  it('wakes a suspended VM (retries /health past a 502) before piping a WS upgrade', async () => {
    let healthCalls = 0
    installH2((_headers, stream) => {
      healthCalls++
      h2Respond(stream, healthCalls === 1 ? 502 : 200, '')
    })
    let tlsCalled = false
    const tlsReady = new Promise<void>((resolve) => {
      tlsConnectMock.mockImplementation((_opts: unknown, cb: () => void) => {
        tlsCalled = true
        const sock = new PassThrough()
        process.nextTick(cb)
        resolve()
        return sock
      })
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    const client = net.connect(port, '127.0.0.1', () => {
      client.write('GET /sessions/s1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    await tlsReady
    client.destroy()
    expect(healthCalls).toBeGreaterThanOrEqual(2) // retried past the 502
    expect(tlsCalled).toBe(true) // only piped once the VM was awake
  })

  it('retries after an HTTP/2 connect error then returns the body', async () => {
    let connects = 0
    http2ConnectImpl = () => {
      connects++
      if (connects === 1) {
        return {
          closed: false,
          destroyed: false,
          request() { throw new Error('should not request') },
          destroy() { this.destroyed = true; this.closed = true },
          close() { this.closed = true },
          on() { return this },
          off() { return this },
          once(ev: string, cb: (err?: Error) => void) {
            if (ev === 'error') process.nextTick(() => cb(new Error('alpn rejected')))
            return this
          },
        }
      }
      return mockH2Session((_headers, stream) => h2Respond(stream, 200, 'UPSTREAM_OK'))
    }
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    const res = await httpGet(port, '/health')
    expect(res.status).toBe(200)
    expect(res.body).toBe('UPSTREAM_OK')
    expect(connects).toBe(2)
  })

  it('retries an ingress 429 then returns the successful body', async () => {
    let calls = 0
    installH2((_headers, stream) => {
      calls++
      h2Respond(stream, calls === 1 ? 429 : 200, calls === 1 ? 'Rate limit exceeded' : 'UPSTREAM_OK')
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    const res = await httpGet(port, '/artifacts/open-slide-studio/')
    expect(res.status).toBe(200)
    expect(res.body).toBe('UPSTREAM_OK')
    expect(calls).toBe(2)
  })

  it('multiplexes HTTP requests on one HTTP/2 session', async () => {
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    const [first, second] = await Promise.all([httpGet(port, '/a'), httpGet(port, '/b')])
    expect(first.body).toBe('UPSTREAM_OK')
    expect(second.body).toBe('UPSTREAM_OK')
    expect(http2ConnectCalls).toBe(1)
  })

  it('keeps HTTP/2 streams flowing while a WebSocket is open', async () => {
    const tlsReady = new Promise<void>((resolve) => {
      tlsConnectMock.mockImplementation((_opts: unknown, cb: () => void) => {
        const sock = new PassThrough()
        process.nextTick(() => {
          cb()
          resolve()
        })
        return sock
      })
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    const wsClient = net.connect(port, '127.0.0.1', () => {
      wsClient.write('GET /sessions/s1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n')
    })
    await tlsReady
    const [first, second] = await Promise.all([httpGet(port, '/a'), httpGet(port, '/b')])
    expect(first.body).toBe('UPSTREAM_OK')
    expect(second.body).toBe('UPSTREAM_OK')
    wsClient.destroy()
  })

  it('does not report a client abort to Sentry', async () => {
    vi.mocked(captureException).mockClear()
    http2ConnectImpl = () => mockH2Session((_headers, stream) => {
      stream.end = ((() => stream) as unknown as typeof stream.end)
      stream.push(Buffer.from('partial'))
      process.nextTick(() => stream.emit('response', { ':status': 200 }))
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/asset.js' }, (res) => {
        res.resume()
        req.destroy()
        resolve()
      })
      req.on('error', () => {})
      req.setTimeout(2000, () => reject(new Error('client got no response')))
      req.end()
    })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(captureException).not.toHaveBeenCalled()
  })

  it('reports a non-abort pipeline error to Sentry', async () => {
    vi.mocked(captureException).mockClear()
    installH2((_headers, stream) => {
      process.nextTick(() => {
        stream.emit('response', { ':status': 200 })
        stream.destroy(new Error('upstream exploded'))
      })
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    await httpGet(port, '/asset.js').catch(() => {})
    await vi.waitFor(() => expect(captureException).toHaveBeenCalled())
    expect(vi.mocked(captureException).mock.calls[0][0]).toMatchObject({ message: 'upstream exploded' })
  })

  it('closes a session that connects after stop()', async () => {
    let connectCb: (() => void) | undefined
    const session = {
      closed: false,
      destroyed: false,
      request() { throw new Error('should not request') },
      destroy() { this.destroyed = true; this.closed = true },
      close() { this.closed = true },
      on() { return this },
      off() { return this },
      once(ev: string, cb: () => void) {
        if (ev === 'connect') connectCb = cb
        return this
      },
    }
    http2ConnectImpl = () => session
    const proxy = makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' }))
    const port = await proxy.start()
    const pending = httpGet(port, '/health').catch(() => {})
    await vi.waitFor(() => { if (!connectCb) throw new Error('connect not armed') })
    proxy.stop()
    connectCb!()
    expect(session.closed).toBe(true)
    await pending
  })

  it('destroys the client socket if the WS upstream connect never completes', async () => {
    // /health is healthy (VM awake) but the TLS connect callback never fires, so
    // the connect-phase timer (real, but we trigger the error path) tears it down.
    tlsConnectMock.mockImplementation(() => {
      const sock = new PassThrough() as PassThrough & { destroy: (e?: Error) => void }
      process.nextTick(() => sock.emit('error', new Error('connect refused')))
      return sock
    })
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' })).start()
    const closed = new Promise<void>((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write('GET /sessions/s1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n')
      })
      client.on('close', () => resolve())
    })
    await closed
    expect(true).toBe(true)
  })
})

describe('attachMicrovmUpstreamKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a masked client WS ping frame on the MicroVM keepalive interval', () => {
    const write = vi.fn()
    const upstream = { destroyed: false, write } as unknown as import('net').Socket
    const dispose = attachMicrovmUpstreamKeepalive(upstream)

    vi.advanceTimersByTime(MICROVM_STREAM_KEEPALIVE_MS - 1)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(1)
    const frame = write.mock.calls[0][0] as Buffer
    expect(frame).toHaveLength(6)
    expect(frame[0]).toBe(0x89)
    expect(frame[1]).toBe(0x80)
    vi.advanceTimersByTime(MICROVM_STREAM_KEEPALIVE_MS)
    expect(write).toHaveBeenCalledTimes(2)

    dispose()
    vi.advanceTimersByTime(MICROVM_STREAM_KEEPALIVE_MS * 2)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('creates a client ping accepted by a WebSocket server', async () => {
    vi.useRealTimers()
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const socket = net.connect(port, '127.0.0.1')
    const connected = new Promise<import('ws').WebSocket>((resolve) => wss.once('connection', resolve))
    let websocket: import('ws').WebSocket | undefined
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write([
        'GET / HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'))

      websocket = await connected
      const ping = new Promise<Buffer>((resolve, reject) => {
        websocket!.once('ping', resolve)
        websocket!.once('error', reject)
      })
      socket.write(createMicrovmWebSocketPingFrame())
      await expect(ping).resolves.toEqual(Buffer.alloc(0))
    } finally {
      socket.destroy()
      websocket?.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve())
        })
      }
    }
  })

  it('skips write when the upstream socket is destroyed', () => {
    const write = vi.fn()
    const upstream = { destroyed: true, write } as unknown as import('net').Socket
    const dispose = attachMicrovmUpstreamKeepalive(upstream)
    vi.advanceTimersByTime(MICROVM_STREAM_KEEPALIVE_MS)
    expect(write).not.toHaveBeenCalled()
    dispose()
  })
})

describe('LambdaMicroVmRuntimeClient.observeUnexpectedDeath', () => {
  beforeEach(() => {
    Object.assign(process.env, FULL_ENV)
    resetMicrovmRuntimeForTests()
  })

  function newClient() {
    return new LambdaMicroVmRuntimeClient({
      agentId: 'agent-xyz',
      envVars: { FOO: 'bar' },
      restartAgent: async () => {},
    })
  }

  function sessionFetch(isRunning: boolean) {
    vi.mocked(fetch).mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('/sessions/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'sess-1', isRunning }),
        } as unknown as Response
      }
      return { ok: true } as Response
    })
  }

  it('recovers max_lifetime with replace when GetMicrovm reports the 8h reason', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'TERMINATED'
    responses.getStateReason = 'MicroVM exceeded maximum lifetime.'
    sessionFetch(false)

    await expect(client.observeUnexpectedDeath({ sessionIds: ['sess-1'] })).resolves.toEqual({
      action: 'recover',
      reason: 'max_lifetime',
      resumePrompt: expect.stringContaining('8-hour lifetime'),
      replaceGeneration: true,
    })
  })

  it('recovers guest_oom without replace when SIGKILL + RUNNING + probe fail', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'RUNNING'
    delete responses.getStateReason
    sessionFetch(false)

    await expect(
      client.observeUnexpectedDeath({
        lastFatalResult: 'oom_sigkill',
        sessionIds: ['sess-1'],
      }),
    ).resolves.toEqual({
      action: 'recover',
      reason: 'guest_oom',
      resumePrompt: expect.stringContaining('ran out of memory'),
      replaceGeneration: false,
    })
  })

  it('ignores a WS blip when the VM is RUNNING and the session probe succeeds', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'RUNNING'
    sessionFetch(true)

    await expect(client.observeUnexpectedDeath({ sessionIds: ['sess-1'] })).resolves.toEqual({
      action: 'ignore',
    })
  })

  function failGetMicrovm() {
    sendMock.mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === 'Get') throw new Error('ThrottlingException')
      if (cmd.type === 'Token') return { authToken: { 'X-aws-proxy-auth': 'tok' } }
      return {}
    })
  }

  it('ignores when GetMicrovm fails but the live probe still sees the session running', async () => {
    const client = newClient()
    await client.start()
    sessionFetch(true)
    failGetMicrovm()

    await expect(client.observeUnexpectedDeath({ sessionIds: ['sess-1'] })).resolves.toEqual({
      action: 'ignore',
    })
  })

  it('fails closed to settle when GetMicrovm fails and the probe cannot confirm the session', async () => {
    const client = newClient()
    await client.start()
    sessionFetch(false)
    failGetMicrovm()

    await expect(client.observeUnexpectedDeath({ sessionIds: ['sess-1'] })).resolves.toEqual({
      action: 'settle',
    })
  })

  it('defers SIGKILL fatals and settles other fatals', () => {
    const client = newClient()
    expect(client.onFatalResult('oom_sigkill')).toBe('defer_for_recovery')
    expect(client.onFatalResult(null)).toBe('settle')
  })
})
