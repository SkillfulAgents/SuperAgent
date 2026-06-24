import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import net from 'net'
import { PassThrough } from 'stream'

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
  resetMicrovmRuntimeForTests,
  resolveMicrovmRuntimeConfigOrNull,
  isMicrovmRuntimeConfigured,
  getMicrovmRuntimeConfig,
  resolveIdleSeconds,
} from './lambda-microvm-runtime'

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
  'MICROVM_AGENT_PORT', 'MICROVM_MAX_DURATION_SECONDS', 'MICROVM_IDLE_SECONDS', 'MICROVM_SUSPENDED_SECONDS', 'MICROVM_LOG_GROUP',
  'MICROVM_FS_ID', 'MICROVM_ACCESS_POINT', 'MICROVM_MOUNT_TARGET_IP',
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
    // idle has no static default — it's resolved from the app setting at start().
    expect(config.idleSeconds).toBeUndefined()
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
      MICROVM_IDLE_SECONDS: '60',
      MICROVM_SUSPENDED_SECONDS: '120',
      MICROVM_MAX_DURATION_SECONDS: '600',
    })
    const config = getMicrovmRuntimeConfig()
    expect(config.agentPort).toBe(8080)
    expect(config.idleSeconds).toBe(60)
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

  it('derives the idle window from the app auto-sleep setting when no env override', () => {
    autoSleepTimeoutMinutes.mockReturnValue(30)
    expect(resolveIdleSeconds(getMicrovmRuntimeConfig())).toBe(1_800)
  })

  it('an explicit MICROVM_IDLE_SECONDS env overrides the app setting', () => {
    process.env.MICROVM_IDLE_SECONDS = '60'
    resetMicrovmRuntimeForTests()
    autoSleepTimeoutMinutes.mockReturnValue(30)
    expect(resolveIdleSeconds(getMicrovmRuntimeConfig())).toBe(60)
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
    expect(payload.env.FOO).toBe('bar') // the agent's configured env is delivered
    expect(payload.mount).toBeUndefined() // no mount configured here
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
    expect(payload.env.FOO).toBe('bar')
    expect(payload.mount).toEqual({ fsId: 'fs-1', accessPoint: 'fsap-1', mountTargetIp: '10.0.0.5' })
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

  it('getInfoFromRuntime treats SUSPENDED as running (auto-resume on request)', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'SUSPENDED'
    expect((await client.getInfoFromRuntime()).status).toBe('running')
  })

  it('getInfoFromRuntime reports stopped when the VM is TERMINATED', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'TERMINATED'
    expect(await client.getInfoFromRuntime()).toEqual({ status: 'stopped', port: null })
  })

  it('stop terminates the MicroVM', async () => {
    const client = newClient()
    await client.start()
    const result = await client.stop()
    expect(result).toEqual({ forceStopUsed: false, stopped: true })
    const terminateCall = sendMock.mock.calls.find((c) => c[0].type === 'Terminate')
    expect(terminateCall![0].input).toEqual({ microvmIdentifier: 'mvm-1' })
  })

  it('auto-sleep stop (escalateToForceStop:false) suspends and preserves state for resume', async () => {
    const client = newClient()
    await client.start()
    sendMock.mockClear()

    const result = await client.stop({ escalateToForceStop: false })

    expect(result).toEqual({ forceStopUsed: false, stopped: true })
    const suspendCall = sendMock.mock.calls.find((c) => c[0].type === 'Suspend')
    expect(suspendCall![0].input).toEqual({ microvmIdentifier: 'mvm-1' })
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Terminate')).toBe(false)

    // State is preserved: a subsequent start() short-circuits (no new RunMicrovm).
    sendMock.mockClear()
    responses.getState = 'SUSPENDED'
    await client.start()
    expect(sendMock.mock.calls.some((c) => c[0].type === 'Run')).toBe(false)
  })

  it('auto-sleep stop is a no-op suspend when already SUSPENDED', async () => {
    const client = newClient()
    await client.start()
    responses.getState = 'SUSPENDED'
    sendMock.mockClear()
    await client.stop({ escalateToForceStop: false })
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

  function makeProxy(mintToken: () => Promise<Record<string, string>>) {
    const proxy = new LocalAuthForwardProxy({ endpoint: 'mvm.lambda-microvm.aws', agentPort: 3000, mintToken })
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
          'Sec-WebSocket-Key: thekey\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    await ready
    client.destroy()
    expect(capturedTls.host).toBe('mvm.lambda-microvm.aws')
    expect(written).toContain('GET /sessions/s1/stream HTTP/1.1')
    expect(written.toLowerCase()).toContain('sec-websocket-key: thekey')
    expect(written.toLowerCase()).toContain('x-aws-proxy-auth: tokws')
    expect(written.toLowerCase()).toContain('x-aws-proxy-port: 3000')
  })
})
