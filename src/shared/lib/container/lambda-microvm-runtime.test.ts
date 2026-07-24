import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import net from 'net'
import { PassThrough } from 'stream'
import { WebSocketServer } from 'ws'

const sendMock = vi.fn()
const responses: Record<string, unknown> = {}

// Upstream transports are mocked so the proxy's real loopback server can be
// driven by real http/net clients while we capture what it forwards upstream.
const httpsRequestMock = vi.fn()
const tlsConnectMock = vi.fn()
vi.mock('https', () => ({
  default: { request: (...a: unknown[]) => httpsRequestMock(...a) },
  request: (...a: unknown[]) => httpsRequestMock(...a),
}))
vi.mock('tls', () => ({
  default: { connect: (...a: unknown[]) => tlsConnectMock(...a) },
  connect: (...a: unknown[]) => tlsConnectMock(...a),
}))

vi.mock('@aws-sdk/client-lambda-microvms', () => {
  class RunMicrovmCommand { type = 'Run'; constructor(public input: unknown) {} }
  class GetMicrovmCommand { type = 'Get'; constructor(public input: unknown) {} }
  class SuspendMicrovmCommand { type = 'Suspend'; constructor(public input: unknown) {} }
  class TerminateMicrovmCommand { type = 'Terminate'; constructor(public input: unknown) {} }
  class CreateMicrovmAuthTokenCommand { type = 'Token'; constructor(public input: unknown) {} }
  return {
    LambdaMicrovmsClient: class { send = (cmd: { type: string }) => sendMock(cmd) },
    RunMicrovmCommand,
    GetMicrovmCommand,
    SuspendMicrovmCommand,
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
  resolveIdleSeconds,
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
  'MICROVM_AGENT_PORT', 'MICROVM_MAX_DURATION_SECONDS', 'MICROVM_SUSPENDED_SECONDS', 'MICROVM_LOG_GROUP',
  'MICROVM_FS_ID', 'MICROVM_ACCESS_POINT', 'MICROVM_MOUNT_TARGET_IP', 'ECS_CONTAINER_METADATA_URI_V4', 'PORT',
  'MICROVM_PROXY_URL', 'MICROVM_PROXY_TOKEN',
]

beforeEach(() => {
  for (const k of TOUCHED) delete process.env[k]
  for (const k in responses) delete responses[k]
  autoSleepTimeoutMinutes.mockReturnValue(30)
  sendMock.mockReset()
  httpsRequestMock.mockReset()
  tlsConnectMock.mockReset()
  sendMock.mockImplementation(async (cmd: { type: string }) => {
    if (cmd.type === 'Run') return { microvmId: 'mvm-1', endpoint: 'ep.lambda-microvm.aws' }
    if (cmd.type === 'Get') return { state: responses.getState ?? 'RUNNING' }
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
    // Lifetime + suspend default to the AWS 8h cap: a suspended VM survives
    // "until killed" and only the ceiling force-terminates an untouched one.
    expect(config.maxDurationSeconds).toBe(28_800)
    expect(config.suspendedSeconds).toBe(28_800)
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
      MICROVM_SUSPENDED_SECONDS: '120',
      MICROVM_MAX_DURATION_SECONDS: '600',
    })
    const config = getMicrovmRuntimeConfig()
    expect(config.agentPort).toBe(8080)
    expect(config.suspendedSeconds).toBe(120)
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

describe('resolveIdleSeconds', () => {
  beforeEach(() => {
    Object.assign(process.env, REQUIRED_ENV)
  })

  it('derives the idle window from the app auto-sleep setting (single source of truth)', () => {
    autoSleepTimeoutMinutes.mockReturnValue(30)
    expect(resolveIdleSeconds(getMicrovmRuntimeConfig())).toBe(1_800)
  })

  it('never idle-suspends (falls back to the lifetime cap) when auto-sleep is disabled', () => {
    autoSleepTimeoutMinutes.mockReturnValue(0)
    const config = getMicrovmRuntimeConfig()
    expect(resolveIdleSeconds(config)).toBe(config.maxDurationSeconds)
  })

  it('clamps an app setting longer than the lifetime cap to maxDurationSeconds', () => {
    autoSleepTimeoutMinutes.mockReturnValue(600) // 10h > 8h cap
    const config = getMicrovmRuntimeConfig()
    expect(resolveIdleSeconds(config)).toBe(config.maxDurationSeconds)
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

  function newClient() {
    // envVars is the public seam: whatever the agent is configured with must
    // arrive inside runHookPayload.env, regardless of how the env is built.
    return new LambdaMicroVmRuntimeClient({ agentId: 'agent-xyz', envVars: { FOO: 'bar' } })
  }

  it('start runs a MicroVM with image/role/connectors and becomes healthy', async () => {
    await newClient().start()
    const runCall = sendMock.mock.calls.find((c) => c[0].type === 'Run')
    expect(runCall).toBeTruthy()
    const input = runCall![0].input
    expect(input.imageIdentifier).toBe('arn:img')
    expect(input.executionRoleArn).toBe('arn:exec')
    expect(input.egressNetworkConnectors).toEqual(['arn:egress'])
    expect(input.idlePolicy.autoResumeEnabled).toBe(true)
    // idle tracks the app auto-sleep setting (30m); suspend/lifetime hit the 8h cap.
    expect(input.idlePolicy.maxIdleDurationSeconds).toBe(1_800)
    expect(input.idlePolicy.suspendedDurationSeconds).toBe(28_800)
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

  it('getInfoFromRuntime treats SUSPENDED as stopped (warm idle; local state kept)', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'SUSPENDED'
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })

    // Warm-idle must not drop local state — a later start() resumes, not Run.
    responses.getState = 'RUNNING'
    sendMock.mockClear()
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
  })

  it('getInfoFromRuntime treats SUSPENDING as stopped (warm idle; local state kept)', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'SUSPENDING'
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
  })

  it('stop() then getInfoFromRuntime reports stopped while suspended', async () => {
    const client = newClient()
    await client.start()
    await client.stop()
    responses.getState = 'SUSPENDED'
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
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

  it('background auto-sleep (escalateToForceStop:false) suspends via host AutoSleepMonitor', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    await client.stop({ escalateToForceStop: false })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Suspend')).toBe(true)
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)
  })

  it('seeds in-memory activity on start and exposes it for auto-sleep', async () => {
    const client = newClient()
    expect(client.getCachedLastActivityMs()).toBeUndefined()
    const before = Date.now()
    await client.start()
    const activity = client.getCachedLastActivityMs()
    expect(activity).toBeTypeOf('number')
    expect(activity!).toBeGreaterThanOrEqual(before)
  })

  it('a plain stop() suspends (preserves state for warm resume), not terminate', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    const result = await client.stop()

    expect(result).toEqual({ forceStopUsed: false, stopped: true })
    const suspendCall = sendMock.mock.calls.find((c) => c[0].type === 'Suspend')
    expect(suspendCall![0].input).toEqual({ microvmIdentifier: 'mvm-1' })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)

    // State is preserved: start() resumes via /health (no new RunMicrovm).
    sendMock.mockClear()
    responses.getState = 'SUSPENDED'
    vi.stubGlobal('fetch', vi.fn(async () => {
      responses.getState = 'RUNNING'
      return { ok: true } as Response
    }))
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
    expect((await client.getInfoFromRuntime()).status).toBe('running')
  })

  it('a plain stop() is a no-op suspend when already SUSPENDED', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'SUSPENDED'
    sendMock.mockClear()
    await client.stop()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Suspend')).toBe(false)
  })

  it('start is a no-op when the agent is already running', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
  })
})

describe('LocalAuthForwardProxy', () => {
  let capturedRequest: { host?: string; path?: string; headers?: Record<string, string> }
  const proxies: LocalAuthForwardProxy[] = []

  beforeEach(() => {
    capturedRequest = {}
    httpsRequestMock.mockImplementation((options: typeof capturedRequest, cb: (res: PassThrough) => void) => {
      capturedRequest = options
      const upstreamRes = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> }
      upstreamRes.statusCode = 200
      upstreamRes.headers = {}
      cb(upstreamRes)
      upstreamRes.end('UPSTREAM_OK')
      return new PassThrough() // stands in for the upstream client request (req.pipe target)
    })
  })

  afterEach(() => {
    for (const p of proxies.splice(0)) p.stop()
  })

  function makeProxy(
    mintToken: () => Promise<Record<string, string>>,
    onActivity?: () => void,
  ) {
    const proxy = new LocalAuthForwardProxy({
      endpoint: 'mvm.lambda-microvm.aws',
      agentPort: 3000,
      mintToken,
      onActivity,
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
    const res = await httpGet(port, '/sessions', { connection: 'keep-alive', 'x-custom': 'v' })
    expect(res.body).toBe('UPSTREAM_OK')
    expect(capturedRequest.host).toBe('mvm.lambda-microvm.aws')
    expect(capturedRequest.path).toBe('/sessions')
    expect(capturedRequest.headers!['X-aws-proxy-auth']).toBe('tok1')
    expect(capturedRequest.headers!['x-aws-proxy-port']).toBe('3000')
    expect(capturedRequest.headers!.host).toBe('mvm.lambda-microvm.aws')
    expect(capturedRequest.headers!['x-custom']).toBe('v')
    expect(capturedRequest.headers!.connection).toBeUndefined()
  })

  it('touches onActivity for real traffic but not /health liveness probes', async () => {
    const onActivity = vi.fn()
    const port = await makeProxy(async () => ({ 'X-aws-proxy-auth': 'tok' }), onActivity).start()
    await httpGet(port, '/health')
    expect(onActivity).not.toHaveBeenCalled()
    await httpGet(port, '/sessions')
    expect(onActivity).toHaveBeenCalledTimes(1)
    await httpGet(port, '/health?ready=1')
    expect(onActivity).toHaveBeenCalledTimes(1)
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
    httpsRequestMock.mockImplementation((_opts: unknown, cb: (res: PassThrough) => void) => {
      healthCalls++
      const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> }
      res.statusCode = healthCalls === 1 ? 502 : 200 // first probe: still resuming
      res.headers = {}
      cb(res)
      res.end('')
      return new PassThrough()
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
