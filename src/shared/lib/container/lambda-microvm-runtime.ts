import http from 'http'
import https from 'https'
import tls from 'tls'
import net, { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import { z } from 'zod'
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  GetMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
} from '@aws-sdk/client-lambda-microvms'
import type {
  CreateMicrovmAuthTokenCommandOutput,
  GetMicrovmCommandOutput,
  RunMicrovmCommandOutput,
} from '@aws-sdk/client-lambda-microvms'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { setBootstrapEnv, clearBootstrapEnv } from './agent-bootstrap-env-store'

// RunMicrovm caps runHookPayload at 4096 bytes. We only put a small bootstrap
// credential + mount params here; the full agent env is fetched at boot (see
// start()). This guard backstops an unexpectedly large payload.
const RUN_HOOK_PAYLOAD_MAX_BYTES = 4_096
const AUTH_TOKEN_EXPIRATION_MINUTES = 60
// Max wait to kick a (possibly suspended) VM back to a serveable agent before a real
// request. Covers auto-resume (~2-10s) with headroom; returns as soon as /health is ok.
const RESUME_KICK_TIMEOUT_MS = 60_000
// Gap between proxy retries while a suspended VM wakes (it 502s for ~2-3s).
const RESUME_RETRY_DELAY_MS = 400
// Idle timeout on a single upstream exchange (HTTP request, or the WS connect
// handshake). Guards against a silently hung socket that never errors or 502s,
// which would otherwise wedge the resume-retry loop forever. Disabled once a WS
// handshake completes (a live stream is idle by design).
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000
const ECS_METADATA_TIMEOUT_MS = 2_000
// Quiet session streams through MicroVM ingress die at ~60s without traffic.
export const MICROVM_STREAM_KEEPALIVE_MS = 25_000

export function createMicrovmWebSocketPingFrame(): Buffer {
  // Client-to-server frames require a fresh masking key, even with no payload.
  return Buffer.concat([Buffer.from([0x89, 0x80]), randomBytes(4)])
}

/** Keep MicroVM ingress from idle-cutting a quiet proxied WS stream. */
export function attachMicrovmUpstreamKeepalive(upstream: net.Socket): () => void {
  const timer = setInterval(() => {
    if (upstream.destroyed) return
    try {
      upstream.write(createMicrovmWebSocketPingFrame())
    } catch (error) {
      console.warn('[LocalAuthForwardProxy] WebSocket ping failed:', error)
    }
  }, MICROVM_STREAM_KEEPALIVE_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

const ecsContainerMetadataSchema = z.object({
  Networks: z.array(z.object({
    IPv4Addresses: z.array(z.string().refine((ip) => net.isIP(ip) === 4)).optional().default([]),
  })).optional().default([]),
})

const hostAppPortSchema = z.preprocess(
  (value) => (value === undefined || value === '' ? CONTAINER_INTERNAL_PORT : value),
  z.coerce.number().int().positive().max(65_535),
)

let memoizedHostPrivateIp: string | null | undefined

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

function getPublicHostApiBaseUrl(): string {
  const publicUrl = process.env.HOST_PUBLIC_URL?.replace(/\/+$/, '')
  if (!publicUrl) {
    throw new Error('HOST_PUBLIC_URL is required for the MicroVM runtime')
  }
  return publicUrl
}

async function resolveHostPrivateIpFromEcsMetadata(): Promise<string | null> {
  if (memoizedHostPrivateIp !== undefined) return memoizedHostPrivateIp

  const metadataUrl = process.env.ECS_CONTAINER_METADATA_URI_V4?.trim()
  if (!metadataUrl) {
    memoizedHostPrivateIp = null
    return memoizedHostPrivateIp
  }

  try {
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(ECS_METADATA_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`ECS metadata returned HTTP ${response.status}`)
    const metadata = ecsContainerMetadataSchema.parse(await response.json())
    memoizedHostPrivateIp = metadata.Networks.flatMap((network) => network.IPv4Addresses)[0] ?? null
    return memoizedHostPrivateIp
  } catch (error) {
    console.warn('[LambdaMicroVmRuntimeClient] Failed to resolve ECS task private IP; falling back to HOST_PUBLIC_URL', error)
    captureException(error, { tags: { area: 'container', op: 'microvm.resolveHostPrivateIp' } })
    memoizedHostPrivateIp = null
    return memoizedHostPrivateIp
  }
}

async function resolveHostApiBaseUrlForMicrovm(): Promise<string> {
  const privateIp = await resolveHostPrivateIpFromEcsMetadata()
  if (!privateIp) return getPublicHostApiBaseUrl()

  const port = hostAppPortSchema.parse(process.env.PORT)
  return `http://${privateIp}:${port}`
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
  /** Called on real user/agent traffic (not /health liveness probes). */
  onActivity?: () => void
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
        { host: this.options.endpoint, port: 443, method, path, servername: this.options.endpoint, headers, timeout: UPSTREAM_IDLE_TIMEOUT_MS },
        resolve,
      )
      upstream.on('error', reject)
      // A hung socket fires 'timeout' (not 'error'); destroy so the caller's
      // retry loop sees a real error instead of blocking on it indefinitely.
      upstream.on('timeout', () => upstream.destroy(new Error('microvm upstream request timed out')))
      if (body.length) upstream.write(body)
      upstream.end()
    })
  }

  // Wake a (possibly suspended) VM and confirm it serves before we start an
  // unreplayable WS pipe. Reuses the HTTP forward+retry over /health so a 502
  // (resuming) or connection refusal (still waking) is retried within the budget.
  private async waitForUpstreamReady(): Promise<boolean> {
    const deadline = Date.now() + RESUME_KICK_TIMEOUT_MS
    for (;;) {
      let auth: Record<string, string>
      try {
        auth = await this.authHeaders()
      } catch (error) {
        captureException(error, { tags: { area: 'container', op: 'microvm.proxy.token' }, extra: { endpoint: this.options.endpoint } })
        return false
      }
      try {
        const res = await this.forwardOnce('GET', '/health', { host: this.options.endpoint, ...auth }, Buffer.alloc(0))
        res.resume()
        if (res.statusCode !== 502) return true
      } catch {
        // Connection refused/reset/timeout = VM still waking; retry below.
      }
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, RESUME_RETRY_DELAY_MS))
    }
  }

  // Replay requests across the brief resume window, where AWS may 502/refuse.
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isLivenessProbePath(req.url)) this.options.onActivity?.()
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
    this.options.onActivity?.()
    // A WS upgrade can't be replayed once piped, so kick the VM awake over HTTP
    // (with the same resume-retry HTTP requests get) before opening the stream.
    if (!(await this.waitForUpstreamReady())) {
      socket.destroy()
      return
    }
    let auth: Record<string, string>
    try {
      auth = await this.authHeaders()
    } catch (error) {
      captureException(error, { tags: { area: 'container', op: 'microvm.proxy.token' }, extra: { endpoint: this.options.endpoint } })
      socket.destroy()
      return
    }
    // Manual connect-phase deadline only: a live WS stream is idle by design, so
    // we must NOT arm a socket idle-timeout that would later kill a quiet stream.
    let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
      connectTimer = null
      upstream.destroy(new Error('microvm upstream WS connect timed out'))
    }, UPSTREAM_IDLE_TIMEOUT_MS)
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
    }
    let stopKeepalive: (() => void) | null = null
    const upstream = tls.connect({ host: this.options.endpoint, port: 443, servername: this.options.endpoint }, () => {
      clearConnectTimer()
      // Keep WS handshake headers (HOP_BY_HOP would drop upgrade/connection) and
      // forward the same application headers HTTP uses — especially
      // x-superagent-host-token. Stripping it makes the agent return 401 on
      // upgrade while createSession (HTTP) still succeeds.
      const headerLines = [`GET ${req.url} HTTP/1.1`, `Host: ${this.options.endpoint}`]
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase()
        if (value === undefined) continue
        const keep =
          lower.startsWith('sec-websocket') ||
          lower === 'upgrade' ||
          lower === 'connection' ||
          lower === 'origin' ||
          !HOP_BY_HOP.has(lower)
        if (!keep) continue
        headerLines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      for (const [key, value] of Object.entries(auth)) headerLines.push(`${key}: ${value}`)
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
      // First ping fires at 25s — well after the 101 handshake completes.
      stopKeepalive = attachMicrovmUpstreamKeepalive(upstream)
    })
    const onError = (error: Error) => {
      clearConnectTimer()
      stopKeepalive?.()
      stopKeepalive = null
      captureException(error, { tags: { area: 'container', op: 'microvm.proxy.upgrade' }, extra: { endpoint: this.options.endpoint } })
      upstream.destroy()
      socket.destroy()
    }
    const onClose = () => {
      stopKeepalive?.()
      stopKeepalive = null
    }
    upstream.on('error', onError)
    socket.on('error', onError)
    upstream.on('close', onClose)
    socket.on('close', onClose)
  }
}

// ---------------------------------------------------------------------------
// Runtime client
// ---------------------------------------------------------------------------

// MicroVM ids are AWS-generated (no deterministic name, no tag-filtered lookup),
// so the agentId→microvm mapping + loopback proxy + activity clock live in RAM.
// Lost on host-app restart: orphaned VMs are reclaimed by idlePolicy
// (idle→suspend→suspended-timeout→terminate); the next start() re-runs.
interface AgentMicrovmState {
  microvmId: string
  endpoint: string
  proxy: LocalAuthForwardProxy
  proxyPort: number
}
const agentStates = new Map<string, AgentMicrovmState>()

// Host-side activity clock for AutoSleepMonitor (avoids S3 Files listSessions I/O).
// Touched on real proxy traffic + start; /health liveness probes are excluded.
const agentLastActivityAt = new Map<string, number>()

function touchAgentActivity(agentId: string): void {
  agentLastActivityAt.set(agentId, Date.now())
}

function isLivenessProbePath(url: string | undefined): boolean {
  const path = (url ?? '/').split('?')[0] ?? '/'
  return path === '/health'
}

type MicrovmDetail = { state?: string; endpoint?: string }

// Control plane selection, keyed on MICROVM_PROXY_URL:
//
//   - unset → call the AWS MicroVM API directly with the task's own IAM. This is
//     the default and works out of the box for open-source / self-hosted setups
//     (no proxy, no token).
//
//   - set   → route every op through an external MicroVM controller instead.
//     Image / exec role / egress connector are never sent — the controller
//     supplies them and enforces ownership; MICROVM_PROXY_TOKEN authenticates
//     the caller.
//
// A URL without a token is a misconfiguration — fail loudly rather than quietly
// falling back to the direct path.
function microvmService(): { url: string; token: string } | null {
  const url = process.env.MICROVM_PROXY_URL?.replace(/\/+$/, '')
  if (!url) return null
  const token = process.env.MICROVM_PROXY_TOKEN
  if (!token) {
    throw new Error(
      'MICROVM_PROXY_URL is set but MICROVM_PROXY_TOKEN is missing. Set ' +
        'MICROVM_PROXY_TOKEN, or unset MICROVM_PROXY_URL to use the direct AWS path.',
    )
  }
  return { url, token }
}

// Marker matching the AWS SDK's not-found error name, so isNotFound() works
// whether the op went through the service (404) or the SDK.
class MicrovmNotFoundError extends Error {
  readonly name = 'ResourceNotFoundException'
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ResourceNotFoundException'
}

let memoizedClient: { region: string; client: LambdaMicrovmsClient } | null = null
function getMicrovmClient(region: string): LambdaMicrovmsClient {
  if (!memoizedClient || memoizedClient.region !== region) {
    memoizedClient = { region, client: new LambdaMicrovmsClient({ region }) }
  }
  return memoizedClient.client
}

async function serviceFetch<T>(
  svc: { url: string; token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${svc.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${svc.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 404) throw new MicrovmNotFoundError(`microvm not found (${path})`)
  if (!res.ok) throw new Error(`microvm service ${method} ${path} failed: ${res.status}`)
  return (await res.json()) as T
}

async function runMicrovm(
  config: MicrovmRuntimeConfig,
  opts: { runHookPayload: string; clientToken: string; logStream: string },
): Promise<{ microvmId: string; endpoint: string }> {
  const idlePolicy = {
    maxIdleDurationSeconds: resolveIdleSeconds(config),
    suspendedDurationSeconds: config.suspendedSeconds,
    autoResumeEnabled: true,
  }
  const logging = config.logGroup
    ? { cloudWatch: { logGroup: config.logGroup, logStream: opts.logStream } }
    : undefined

  const svc = microvmService()
  if (svc) {
    // The service injects image / exec role and VERIFIES egressConnectorArn
    // resolves to this org's connector name before using it, so passing our own
    // connector ARN is a hint (rejected if it isn't ours), not trusted input.
    return serviceFetch(svc, 'POST', '/microvm/run', {
      egressConnectorArn: config.egressConnectorArn,
      imageVersion: config.imageVersion,
      ingressNetworkConnectors: [config.ingressConnectorArn],
      idlePolicy,
      logging,
      maximumDurationInSeconds: config.maxDurationSeconds,
      runHookPayload: opts.runHookPayload,
      clientToken: opts.clientToken,
    })
  }
  const res = (await getMicrovmClient(config.region).send(
    new RunMicrovmCommand({
      imageIdentifier: config.imageArn,
      imageVersion: config.imageVersion,
      executionRoleArn: config.executionRoleArn,
      ingressNetworkConnectors: [config.ingressConnectorArn],
      egressNetworkConnectors: [config.egressConnectorArn],
      idlePolicy,
      logging,
      maximumDurationInSeconds: config.maxDurationSeconds,
      runHookPayload: opts.runHookPayload,
      clientToken: opts.clientToken,
    }),
  )) as RunMicrovmCommandOutput
  if (!res.microvmId || !res.endpoint) throw new Error('RunMicrovm returned no microvmId/endpoint')
  return { microvmId: res.microvmId, endpoint: res.endpoint }
}

async function getMicrovm(region: string, microvmId: string): Promise<MicrovmDetail> {
  const svc = microvmService()
  if (svc) return serviceFetch(svc, 'GET', `/microvm/${encodeURIComponent(microvmId)}`)
  const res = (await getMicrovmClient(region).send(
    new GetMicrovmCommand({ microvmIdentifier: microvmId }),
  )) as GetMicrovmCommandOutput
  return { state: res.state, endpoint: res.endpoint }
}

async function suspendMicrovm(region: string, microvmId: string): Promise<void> {
  const svc = microvmService()
  if (svc) {
    await serviceFetch(svc, 'POST', `/microvm/${encodeURIComponent(microvmId)}/suspend`)
    return
  }
  await getMicrovmClient(region).send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }))
}

async function terminateMicrovm(region: string, microvmId: string): Promise<void> {
  const svc = microvmService()
  if (svc) {
    await serviceFetch(svc, 'DELETE', `/microvm/${encodeURIComponent(microvmId)}`)
    return
  }
  await getMicrovmClient(region).send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }))
}

async function createMicrovmAuthToken(
  region: string,
  microvmId: string,
  allowedPorts: number[],
  expirationInMinutes: number,
): Promise<MicrovmAuthToken> {
  const svc = microvmService()
  if (svc) {
    const out = await serviceFetch<{ authToken: MicrovmAuthToken }>(
      svc,
      'POST',
      `/microvm/${encodeURIComponent(microvmId)}/token`,
      { allowedPorts },
    )
    return out.authToken
  }
  const out = (await getMicrovmClient(region).send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes,
      allowedPorts: allowedPorts.map((port) => ({ port })),
    }),
  )) as CreateMicrovmAuthTokenCommandOutput
  if (!out.authToken) throw new Error('CreateMicrovmAuthToken returned no token')
  return out.authToken
}

export class LambdaMicroVmRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'lambda-microvm'
  // Image is built once via create-microvm-image and run by AWS; nothing local.
  static readonly requiresLocalImage = false
  // Image comes solely from MICROVM_AGENT_IMAGE_ARN/_VERSION; settings.container.agentImage is ignored.
  static readonly supportsCustomAgentImage = false

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

    // Suspended VMs are UI-stopped but still warm — resume before RunMicrovm.
    const existing = agentStates.get(this.config.agentId)
    if (existing && (await this.resumeExisting(existing))) return

    const config = getMicrovmRuntimeConfig()
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
    const hostApiBaseUrl = await this.getHostApiBaseUrl()
    console.info(`[LambdaMicroVmRuntimeClient] Using host API base URL for MicroVM talk-back: ${hostApiBaseUrl}`)
    const bootstrap = hasEnv
      ? {
          url: `${hostApiBaseUrl}/api/agent-bootstrap/${this.config.agentId}/env`,
          token: env.PROXY_TOKEN ?? '',
        }
      : undefined
    // Per-VM secret the supervisor pins on its first (trusted) run hook and then
    // requires on every later /run, so the untrusted in-VM agent can't forge a
    // /run to re-mount /workspace with attacker-chosen S3 Files params. Delivered
    // only in runHookPayload (never in the agent env), so the agent never sees it.
    const hookToken = randomUUID()
    const payloadObj = { ...(bootstrap ? { bootstrap } : {}), ...(mount ? { mount } : {}), hookToken }
    const runHookPayload = JSON.stringify(payloadObj)
    const payloadBytes = runHookPayload ? Buffer.byteLength(runHookPayload, 'utf8') : 0
    if (payloadBytes > RUN_HOOK_PAYLOAD_MAX_BYTES) {
      throw new Error(
        `MicroVM runHookPayload is ${payloadBytes} bytes, over the ${RUN_HOOK_PAYLOAD_MAX_BYTES} limit.`,
      )
    }

    const run = await runMicrovm(config, {
      runHookPayload,
      // Unique per start() — dedupes retries, but never collides with a prior
      // start (a fixed token reused with changed params makes RunMicrovm return
      // InternalFailure on the idempotency conflict).
      clientToken: randomUUID(),
      logStream: this.config.agentId,
    })

    const proxy = new LocalAuthForwardProxy({
      endpoint: run.endpoint,
      agentPort: config.agentPort,
      mintToken: () => this.mintToken(run.microvmId),
      onActivity: () => touchAgentActivity(this.config.agentId),
    })
    const proxyPort = await proxy.start()
    // Stop any stale proxy before overwriting state (no leaked port/listener); stash
    // env after the cleanup (which clears stale stashes) so it isn't wiped.
    this.cleanupLocal()
    if (hasEnv) setBootstrapEnv(this.config.agentId, env)
    agentStates.set(this.config.agentId, { microvmId: run.microvmId, endpoint: run.endpoint, proxy, proxyPort })
    touchAgentActivity(this.config.agentId)

    try {
      await this.waitForRunning(config.region, run.microvmId, 300_000)
      if (!(await this.waitForHealthy(120_000, proxyPort))) {
        throw new Error(`MicroVM agent ${run.microvmId} failed to become healthy`)
      }
    } catch (error) {
      await this.teardown()
      throw error
    }
  }

  // Proxy-level retry handles the suspend→resume 502 window for all HTTP calls.

  async stop(_options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    // Host AutoSleepMonitor owns product idle via in-memory activity; both the
    // background sweep and an explicit stop suspend (idlePolicy is the orphan GC).
    await this.suspend()
    return { forceStopUsed: false, stopped: true }
  }

  getCachedLastActivityMs(): number | undefined {
    return agentLastActivityAt.get(this.config.agentId)
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
      const mvm = await getMicrovm(config.region, state.microvmId)
      if (mvm.state === 'RUNNING') {
        return { status: 'running', port: state.proxyPort }
      }
      // Warm-idle: UI shows stopped; local proxy state is kept so start()/traffic can resume.
      if (mvm.state === 'SUSPENDED' || mvm.state === 'SUSPENDING') {
        return { status: 'stopped', port: null }
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

  public getHostApiBaseUrl(): Promise<string> {
    return resolveHostApiBaseUrlForMicrovm()
  }

  private async mintToken(microvmId: string): Promise<MicrovmAuthToken> {
    const config = getMicrovmRuntimeConfig()
    return createMicrovmAuthToken(config.region, microvmId, [config.agentPort], AUTH_TOKEN_EXPIRATION_MINUTES)
  }

  private async waitForRunning(region: string, microvmId: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const mvm = await getMicrovm(region, microvmId)
      if (mvm.state === 'RUNNING') return
      if (mvm.state === 'TERMINATED' || mvm.state === 'TERMINATING') {
        throw new Error(`MicroVM ${microvmId} entered ${mvm.state} before becoming ready`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    throw new Error(`Timed out waiting for MicroVM ${microvmId} to become RUNNING`)
  }

  // Resume a warm-suspended VM. Returns false when local state is stale (caller should Run).
  // Avoid waitForHealthy here — it treats UI-stopped/suspended as dead and bails early.
  private async resumeExisting(state: AgentMicrovmState): Promise<boolean> {
    const config = getMicrovmRuntimeConfig()
    try {
      const mvm = await getMicrovm(config.region, state.microvmId)
      if (mvm.state === 'TERMINATED' || mvm.state === 'TERMINATING') {
        this.cleanupLocal()
        return false
      }
      if (mvm.state !== 'RUNNING' && mvm.state !== 'SUSPENDED' && mvm.state !== 'SUSPENDING') {
        this.cleanupLocal()
        return false
      }

      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (await this.isHealthy(state.proxyPort)) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!(await this.isHealthy(state.proxyPort))) {
        throw new Error(`MicroVM agent ${state.microvmId} failed to become healthy`)
      }
      await this.waitForRunning(config.region, state.microvmId, 120_000)
      touchAgentActivity(this.config.agentId)
      return true
    } catch (error) {
      if (isNotFound(error)) {
        this.cleanupLocal()
        return false
      }
      throw error
    }
  }

  // Keep local proxy state so the next request auto-resumes the same VM.
  private async suspend(): Promise<void> {
    const state = agentStates.get(this.config.agentId)
    if (!state) return
    const config = getMicrovmRuntimeConfig()
    try {
      const mvm = await getMicrovm(config.region, state.microvmId)
      if (mvm.state === 'SUSPENDED' || mvm.state === 'SUSPENDING') return
      if (mvm.state === 'TERMINATED' || mvm.state === 'TERMINATING') {
        this.cleanupLocal()
        return
      }
      await suspendMicrovm(config.region, state.microvmId)
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
        await terminateMicrovm(config.region, state.microvmId)
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
    agentLastActivityAt.delete(this.config.agentId)
    clearBootstrapEnv(this.config.agentId)
  }
}

export function resetMicrovmRuntimeForTests(): void {
  for (const state of agentStates.values()) state.proxy.stop()
  agentStates.clear()
  agentLastActivityAt.clear()
  memoizedClient = null
  memoizedConfig = null
  memoizedHostPrivateIp = undefined
  configComputed = false
}
