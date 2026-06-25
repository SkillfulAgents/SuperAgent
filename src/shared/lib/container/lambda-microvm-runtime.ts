import http from 'http'
import https from 'https'
import tls from 'tls'
import net, { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  GetMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
} from '@aws-sdk/client-lambda-microvms'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { setBootstrapEnv, clearBootstrapEnv } from './agent-bootstrap-env-store'

// RunMicrovm caps runHookPayload at 4096 bytes (API constraint; the prose "16KB"
// in some docs is wrong). It's meant for small per-agent data (session ids /
// secret references), NOT the full agent env — which exceeds 4096. See the
// env-delivery note in start().
const RUN_HOOK_PAYLOAD_MAX_BYTES = 4_096
const AUTH_TOKEN_EXPIRATION_MINUTES = 60
// Max wait to kick a (possibly suspended) VM back to a serveable agent before a real
// request. Covers auto-resume (~2-10s) with headroom; returns as soon as /health is ok.
const RESUME_KICK_TIMEOUT_MS = 60_000
// Gap between proxy retries while a suspended VM wakes (it 502s for ~2-3s).
const RESUME_RETRY_DELAY_MS = 400

// ---------------------------------------------------------------------------
// Runtime config (env-driven, zod-validated, memoized)
// ---------------------------------------------------------------------------

function allIngressConnectorArn(region: string): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`
}

const microvmRuntimeSchema = z.object({
  region: z.string().min(1),
  imageArn: z.string().min(1),
  imageVersion: z.string().min(1).optional(),
  executionRoleArn: z.string().min(1),
  // Per-org egress connector (gates "agent A only talks to app A" via its SG).
  egressConnectorArn: z.string().min(1),
  ingressConnectorArn: z.string().min(1).optional(),
  agentPort: z.coerce.number().int().positive().default(CONTAINER_INTERNAL_PORT),
  // Total VM lifetime cap (AWS hard max 28_800 = 8h). Default to the max so a
  // suspended VM survives "until killed" — the next request auto-resumes it and
  // only the 8h ceiling force-terminates an untouched VM.
  maxDurationSeconds: z.coerce.number().int().positive().max(28_800).default(28_800),
  // How long a suspended VM is kept before AWS terminates it. Maxed so suspend
  // lasts "until killed" within the 8h lifetime cap.
  suspendedSeconds: z.coerce.number().int().positive().max(28_800).default(28_800),
  logGroup: z.string().min(1).optional(),
  // Per-org S3 Files workspace mount, passed to the image's run hook so the
  // supervisor mounts /workspace. All three required together or none (no mount).
  fsId: z.string().min(1).optional(),
  accessPoint: z.string().min(1).optional(),
  mountTargetIp: z.string().min(1).optional(),
})

export type MicrovmRuntimeConfig = Omit<z.infer<typeof microvmRuntimeSchema>, 'ingressConnectorArn'> & {
  ingressConnectorArn: string
}

let memoizedConfig: MicrovmRuntimeConfig | null = null
let configComputed = false

function computeConfigOrNull(): MicrovmRuntimeConfig | null {
  const parsed = microvmRuntimeSchema.safeParse({
    region: process.env.MICROVM_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    imageArn: process.env.MICROVM_AGENT_IMAGE_ARN,
    imageVersion: process.env.MICROVM_AGENT_IMAGE_VERSION,
    executionRoleArn: process.env.MICROVM_EXECUTION_ROLE_ARN,
    egressConnectorArn: process.env.MICROVM_EGRESS_CONNECTOR_ARN,
    ingressConnectorArn: process.env.MICROVM_INGRESS_CONNECTOR_ARN,
    agentPort: process.env.MICROVM_AGENT_PORT,
    maxDurationSeconds: process.env.MICROVM_MAX_DURATION_SECONDS,
    suspendedSeconds: process.env.MICROVM_SUSPENDED_SECONDS,
    logGroup: process.env.MICROVM_LOG_GROUP,
    fsId: process.env.MICROVM_FS_ID,
    accessPoint: process.env.MICROVM_ACCESS_POINT,
    mountTargetIp: process.env.MICROVM_MOUNT_TARGET_IP,
  })
  if (!parsed.success) return null
  return {
    ...parsed.data,
    ingressConnectorArn: parsed.data.ingressConnectorArn ?? allIngressConnectorArn(parsed.data.region),
  }
}

export function resolveMicrovmRuntimeConfigOrNull(): MicrovmRuntimeConfig | null {
  if (!configComputed) {
    memoizedConfig = computeConfigOrNull()
    configComputed = true
  }
  return memoizedConfig
}

export function getMicrovmRuntimeConfig(): MicrovmRuntimeConfig {
  const config = resolveMicrovmRuntimeConfigOrNull()
  if (!config) {
    throw new Error(
      'MicroVM runtime is not configured: MICROVM_AGENT_IMAGE_ARN, MICROVM_EXECUTION_ROLE_ARN, MICROVM_EGRESS_CONNECTOR_ARN and an AWS region are required',
    )
  }
  return config
}

export function isMicrovmRuntimeConfigured(): boolean {
  return resolveMicrovmRuntimeConfigOrNull() !== null
}

// Idle→suspend window: app settings are the single source of truth.
export function resolveIdleSeconds(config: MicrovmRuntimeConfig): number {
  const minutes = getSettings().app?.autoSleepTimeoutMinutes ?? 30
  if (minutes <= 0) return config.maxDurationSeconds
  return Math.min(minutes * 60, config.maxDurationSeconds)
}

// ---------------------------------------------------------------------------
// Local auth-forward proxy: injects the MicroVM auth-proxy headers into every
// HTTP request and WebSocket upgrade, so BaseContainerClient can talk to a
// MicroVM as if it were a local container without knowing about auth tokens.
// ---------------------------------------------------------------------------

const PROXY_PORT_HEADER = 'x-aws-proxy-port'
// Auth tokens last max 60min; refresh well before so in-flight requests never 401.
const TOKEN_TTL_MS = 50 * 60 * 1000
// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])

export type MicrovmAuthToken = Record<string, string>

export interface ProxyOptions {
  /** MicroVM HTTPS endpoint host (no scheme), from RunMicrovm/GetMicrovm. */
  endpoint: string
  /** Port inside the MicroVM the auth-proxy should forward to (agent server). */
  agentPort: number
  /** Mints a fresh auth-token map ({ "X-aws-proxy-auth": "<jwe>", ... }). */
  mintToken: () => Promise<MicrovmAuthToken>
}

export class LocalAuthForwardProxy {
  private server: http.Server | null = null
  private port: number | null = null
  private tokenCache: { token: MicrovmAuthToken; expiresAt: number } | null = null
  private refreshing: Promise<MicrovmAuthToken> | null = null

  constructor(private readonly options: ProxyOptions) {}

  async start(): Promise<number> {
    if (this.port !== null) return this.port
    const server = http.createServer((req, res) => this.handleRequest(req, res))
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
    return this.port
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = null
    this.tokenCache = null
  }

  // Single-flight token refresh so a burst of requests can't trigger a token storm.
  private async authHeaders(): Promise<Record<string, string>> {
    const now = Date.now()
    if (!this.tokenCache || now >= this.tokenCache.expiresAt) {
      if (!this.refreshing) {
        this.refreshing = this.options
          .mintToken()
          .then((token) => {
            this.tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS }
            return token
          })
          .finally(() => {
            this.refreshing = null
          })
      }
      await this.refreshing
    }
    return { ...this.tokenCache!.token, [PROXY_PORT_HEADER]: String(this.options.agentPort) }
  }

  private forwardableHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
      out[key] = Array.isArray(value) ? value.join(', ') : value
    }
    return out
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private forwardOnce(method: string, path: string, headers: Record<string, string>, body: Buffer): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const upstream = https.request(
        { host: this.options.endpoint, port: 443, method, path, servername: this.options.endpoint, headers },
        resolve,
      )
      upstream.on('error', reject)
      if (body.length) upstream.write(body)
      upstream.end()
    })
  }

  // Replay requests across the brief resume window, where AWS may 502/refuse.
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Buffer
    try {
      body = await this.readBody(req)
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end()
      return
    }
    const deadline = Date.now() + RESUME_KICK_TIMEOUT_MS
    for (;;) {
      let auth: Record<string, string>
      try {
        auth = await this.authHeaders()
      } catch (error) {
        captureException(error, { tags: { area: 'container', op: 'microvm.proxy.token' }, extra: { endpoint: this.options.endpoint } })
        if (!res.headersSent) res.writeHead(502)
        res.end('microvm auth token unavailable')
        return
      }
      const headers = { ...this.forwardableHeaders(req.headers), host: this.options.endpoint, ...auth }
      let upstreamRes: http.IncomingMessage
      try {
        upstreamRes = await this.forwardOnce(req.method ?? 'GET', req.url ?? '/', headers, body)
      } catch (error) {
        // Connection error = VM still waking; retry within the resume budget.
        if (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, RESUME_RETRY_DELAY_MS))
          continue
        }
        captureException(error, { tags: { area: 'container', op: 'microvm.proxy.request' }, extra: { endpoint: this.options.endpoint, path: req.url } })
        if (!res.headersSent) res.writeHead(502)
        res.end()
        return
      }
      // 502 from the endpoint = VM resuming; drain and retry within the budget.
      if (upstreamRes.statusCode === 502 && Date.now() < deadline) {
        upstreamRes.resume()
        await new Promise((r) => setTimeout(r, RESUME_RETRY_DELAY_MS))
        continue
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
      return
    }
  }

  private async handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    let auth: Record<string, string>
    try {
      auth = await this.authHeaders()
    } catch (error) {
      captureException(error, { tags: { area: 'container', op: 'microvm.proxy.token' }, extra: { endpoint: this.options.endpoint } })
      socket.destroy()
      return
    }
    const upstream = tls.connect({ host: this.options.endpoint, port: 443, servername: this.options.endpoint }, () => {
      const headerLines = [`GET ${req.url} HTTP/1.1`, `Host: ${this.options.endpoint}`]
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase()
        if (lower.startsWith('sec-websocket') || lower === 'upgrade' || lower === 'connection' || lower === 'origin') {
          headerLines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        }
      }
      for (const [key, value] of Object.entries(auth)) headerLines.push(`${key}: ${value}`)
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const onError = (error: Error) => {
      captureException(error, { tags: { area: 'container', op: 'microvm.proxy.upgrade' }, extra: { endpoint: this.options.endpoint } })
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', onError)
    socket.on('error', onError)
  }
}

// ---------------------------------------------------------------------------
// Runtime client
// ---------------------------------------------------------------------------

// MicroVM ids are AWS-generated (no deterministic name, no tag-filtered lookup),
// so the agentId→microvm mapping + its loopback proxy live in process memory.
// Lost on host-app restart: the orphaned VM is reclaimed by its idlePolicy
// (idle→suspend→suspended-timeout→terminate) and the next start() re-runs.
interface AgentMicrovmState {
  microvmId: string
  endpoint: string
  proxy: LocalAuthForwardProxy
  proxyPort: number
}
const agentStates = new Map<string, AgentMicrovmState>()

let memoizedClient: LambdaMicrovmsClient | null = null
function getMicrovmClient(region: string): LambdaMicrovmsClient {
  if (!memoizedClient) memoizedClient = new LambdaMicrovmsClient({ region })
  return memoizedClient
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ResourceNotFoundException'
}

export class LambdaMicroVmRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'lambda-microvm'
  // Image is built once via create-microvm-image and run by AWS; nothing local.
  static readonly requiresLocalImage = false

  constructor(config: ContainerConfig) {
    super(config)
  }

  protected getRunnerCommand(): string {
    return 'lambda-microvm'
  }

  static isEligible(): boolean {
    return isMicrovmRuntimeConfigured()
  }

  static async isAvailable(): Promise<boolean> {
    // HOST_PUBLIC_URL is required: agents talk back to host-app via getHostApiBaseUrl().
    return isMicrovmRuntimeConfigured() && Boolean(process.env.HOST_PUBLIC_URL?.trim())
  }

  static async isRunning(): Promise<boolean> {
    return this.isAvailable()
  }

  async start(options?: StartOptions): Promise<void> {
    if ((await this.getInfoFromRuntime()).status === 'running') return

    const config = getMicrovmRuntimeConfig()
    const client = getMicrovmClient(config.region)
    // Full env exceeds the 4096-byte payload cap, so stash it host-side and pass the
    // VM only a small bootstrap credential to fetch it at boot via /api/agent-bootstrap.
    const env = this.buildAgentEnv(options?.envVars)
    const hasEnv = Object.keys(env).length > 0
    // Mount the same per-agent workspace path the k8s runtime uses.
    const mount = config.fsId && config.accessPoint && config.mountTargetIp
      ? {
          fsId: config.fsId,
          accessPoint: config.accessPoint,
          mountTargetIp: config.mountTargetIp,
          subPath: `${process.env.K8S_WORKSPACES_SUBPATH_PREFIX || 'agents'}/${this.config.agentId}/workspace`,
        }
      : undefined
    const bootstrap = hasEnv
      ? {
          url: `${this.getHostApiBaseUrl()}/api/agent-bootstrap/${this.config.agentId}/env`,
          token: env.PROXY_TOKEN ?? '',
        }
      : undefined
    const payloadObj = { ...(bootstrap ? { bootstrap } : {}), ...(mount ? { mount } : {}) }
    const runHookPayload = bootstrap || mount ? JSON.stringify(payloadObj) : undefined
    const payloadBytes = runHookPayload ? Buffer.byteLength(runHookPayload, 'utf8') : 0
    if (payloadBytes > RUN_HOOK_PAYLOAD_MAX_BYTES) {
      throw new Error(
        `MicroVM runHookPayload is ${payloadBytes} bytes, over the ${RUN_HOOK_PAYLOAD_MAX_BYTES} limit.`,
      )
    }

    const run = await client.send(
      new RunMicrovmCommand({
        imageIdentifier: config.imageArn,
        imageVersion: config.imageVersion,
        executionRoleArn: config.executionRoleArn,
        ingressNetworkConnectors: [config.ingressConnectorArn],
        egressNetworkConnectors: [config.egressConnectorArn],
        idlePolicy: {
          maxIdleDurationSeconds: resolveIdleSeconds(config),
          suspendedDurationSeconds: config.suspendedSeconds,
          autoResumeEnabled: true,
        },
        logging: config.logGroup
          ? { cloudWatch: { logGroup: config.logGroup, logStream: this.config.agentId } }
          : undefined,
        maximumDurationInSeconds: config.maxDurationSeconds,
        runHookPayload,
        // Unique per start() — dedupes this call's SDK retries, but never collides
        // with a prior start (a fixed token reused with changed params makes
        // RunMicrovm return InternalFailure on the idempotency conflict).
        clientToken: randomUUID(),
      }),
    )
    if (!run.microvmId || !run.endpoint) {
      throw new Error('RunMicrovm returned no microvmId/endpoint')
    }

    const proxy = new LocalAuthForwardProxy({
      endpoint: run.endpoint,
      agentPort: config.agentPort,
      mintToken: () => this.mintToken(run.microvmId!),
    })
    const proxyPort = await proxy.start()
    // Stop any stale proxy before overwriting state (no leaked port/listener); stash
    // env after the cleanup (which clears stale stashes) so it isn't wiped.
    this.cleanupLocal()
    if (hasEnv) setBootstrapEnv(this.config.agentId, env)
    agentStates.set(this.config.agentId, { microvmId: run.microvmId, endpoint: run.endpoint, proxy, proxyPort })

    try {
      await this.waitForRunning(client, run.microvmId, 300_000)
      if (!(await this.waitForHealthy(120_000, proxyPort))) {
        throw new Error(`MicroVM agent ${run.microvmId} failed to become healthy`)
      }
    } catch (error) {
      await this.teardown()
      throw error
    }
  }

  // Proxy-level retry handles the suspend→resume 502 window for all HTTP calls.

  async stop(options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    // Auto-sleep is handled by AWS idlePolicy; the host-app sweep is a no-op.
    if (options?.escalateToForceStop === false) {
      return { forceStopUsed: false, stopped: true }
    }
    await this.suspend()
    return { forceStopUsed: false, stopped: true }
  }

  stopSync(): void {
    // Terminate uses the async AWS API; sync shutdown only tears down WS + proxy.
    // The VM itself is reclaimed by its idlePolicy.
    this.terminateWebSocketConnections()
    this.cleanupLocal()
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const state = agentStates.get(this.config.agentId)
    if (!state) return { status: 'stopped', port: null }
    const config = getMicrovmRuntimeConfig()
    try {
      const mvm = await getMicrovmClient(config.region).send(
        new GetMicrovmCommand({ microvmIdentifier: state.microvmId }),
      )
      // SUSPENDED is "running on demand": idlePolicy.autoResumeEnabled wakes it
      // on the next request through the proxy.
      if (mvm.state === 'RUNNING' || mvm.state === 'SUSPENDED' || mvm.state === 'SUSPENDING') {
        return { status: 'running', port: state.proxyPort }
      }
      // Terminal: VM is gone — drop state + proxy (mirror NotFound) so it isn't leaked.
      this.cleanupLocal()
      return { status: 'stopped', port: null }
    } catch (error) {
      if (isNotFound(error)) {
        this.cleanupLocal()
        return { status: 'stopped', port: null }
      }
      // Transient (throttling/network): keep last known state so we don't orphan a live
      // VM; container-manager's TTL /health re-probe backstops a genuinely dead one.
      captureException(error, { tags: { area: 'container', op: 'microvm.getInfo' }, extra: { microvmId: state.microvmId } })
      return { status: 'running', port: state.proxyPort }
    }
  }

  async getStats(): Promise<ContainerStats | null> {
    // lambda-microvms exposes no per-VM resource metrics; surface none.
    return null
  }

  public buildVolumeFlag(_hostPath: string, _containerPath: string): string {
    // Workspace is an S3 Files mount performed inside the VM, not a host bind.
    return ''
  }

  public getHostApiBaseUrl(): string {
    const publicUrl = process.env.HOST_PUBLIC_URL?.replace(/\/+$/, '')
    if (!publicUrl) {
      throw new Error('HOST_PUBLIC_URL is required for the MicroVM runtime')
    }
    return publicUrl
  }

  private async mintToken(microvmId: string): Promise<MicrovmAuthToken> {
    const config = getMicrovmRuntimeConfig()
    const out = await getMicrovmClient(config.region).send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: microvmId,
        expirationInMinutes: AUTH_TOKEN_EXPIRATION_MINUTES,
        allowedPorts: [{ port: config.agentPort }],
      }),
    )
    if (!out.authToken) throw new Error('CreateMicrovmAuthToken returned no token')
    return out.authToken
  }

  private async waitForRunning(client: LambdaMicrovmsClient, microvmId: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const mvm = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }))
      if (mvm.state === 'RUNNING') return
      if (mvm.state === 'TERMINATED' || mvm.state === 'TERMINATING') {
        throw new Error(`MicroVM ${microvmId} entered ${mvm.state} before becoming ready`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    throw new Error(`Timed out waiting for MicroVM ${microvmId} to become RUNNING`)
  }

  // Keep local proxy state so the next request auto-resumes the same VM.
  private async suspend(): Promise<void> {
    const state = agentStates.get(this.config.agentId)
    if (!state) return
    const config = getMicrovmRuntimeConfig()
    try {
      const mvm = await getMicrovmClient(config.region).send(
        new GetMicrovmCommand({ microvmIdentifier: state.microvmId }),
      )
      if (mvm.state === 'SUSPENDED' || mvm.state === 'SUSPENDING') return
      if (mvm.state === 'TERMINATED' || mvm.state === 'TERMINATING') {
        this.cleanupLocal()
        return
      }
      await getMicrovmClient(config.region).send(new SuspendMicrovmCommand({ microvmIdentifier: state.microvmId }))
    } catch (error) {
      if (isNotFound(error)) {
        this.cleanupLocal()
        return
      }
      captureException(error, { tags: { area: 'container', op: 'microvm.suspend' }, extra: { microvmId: state.microvmId } })
    }
  }

  private async teardown(): Promise<void> {
    const state = agentStates.get(this.config.agentId)
    if (state) {
      const config = getMicrovmRuntimeConfig()
      try {
        await getMicrovmClient(config.region).send(new TerminateMicrovmCommand({ microvmIdentifier: state.microvmId }))
      } catch (error) {
        if (!isNotFound(error)) {
          captureException(error, { tags: { area: 'container', op: 'microvm.terminate' }, extra: { microvmId: state.microvmId } })
        }
      }
    }
    this.cleanupLocal()
  }

  private cleanupLocal(): void {
    const state = agentStates.get(this.config.agentId)
    state?.proxy.stop()
    agentStates.delete(this.config.agentId)
    clearBootstrapEnv(this.config.agentId)
  }
}

export function resetMicrovmRuntimeForTests(): void {
  for (const state of agentStates.values()) state.proxy.stop()
  agentStates.clear()
  memoizedClient = null
  memoizedConfig = null
  configComputed = false
}
