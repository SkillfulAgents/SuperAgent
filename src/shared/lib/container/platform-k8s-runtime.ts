import { createHash } from 'crypto'
import fs from 'fs'
import https from 'https'
import { z } from 'zod'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from './types'
import { getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { captureException } from '@shared/lib/error-reporting'
import { isRunningInKubernetes } from './runtime-env'

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
const SERVICE_ACCOUNT_TOKEN_PATH = `${SERVICE_ACCOUNT_DIR}/token`
const SERVICE_ACCOUNT_CA_PATH = `${SERVICE_ACCOUNT_DIR}/ca.crt`
const SERVICE_ACCOUNT_NAMESPACE_PATH = `${SERVICE_ACCOUNT_DIR}/namespace`
// Runtime-owned identity labels (k8s recommended keys). The runtime guarantees
// these on every pod/service; external selectors (NetworkPolicy, controllers)
// should target these, not the other way around.
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by'
const COMPONENT_LABEL = 'app.kubernetes.io/component'
const INSTANCE_LABEL = 'app.kubernetes.io/instance'
const AGENT_ID_ANNOTATION = 'superagent.ai/agent-id'
const MANAGED_BY_VALUE = 'superagent'
const COMPONENT_VALUE = 'agent'
// Matches `USER claude` (uid/gid 1000) in agent-container/Dockerfile. Required so
// kubelet can verify runAsNonRoot — a non-numeric image USER fails CreateContainer.
const AGENT_RUN_AS_UID = 1000

export interface KubeConfig {
  namespace: string
  pvcName: string
  workspaceSubPathPrefix: string
  imagePullSecretName: string | null
  // Opaque deployment-supplied metadata stamped onto every pod & service. The
  // runtime never interprets these: Gamut injects gamut.cloud/*, self-host {}.
  extraLabels: Record<string, string>
  extraAnnotations: Record<string, string>
}

export interface OwnerReference {
  apiVersion: string
  kind: string
  name: string
  uid: string
  controller: boolean
  blockOwnerDeletion: boolean
}

type KubeMetadata = {
  name: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: OwnerReference[]
}

type KubeResource = {
  apiVersion: string
  kind: string
  metadata: KubeMetadata
  spec?: Record<string, unknown>
}

interface KubePodStatus {
  phase?: string
  containerStatuses?: Array<{ ready?: boolean }>
}

interface KubeContainerResources {
  limits?: { cpu?: string; memory?: string }
}

interface KubePodSpec {
  containers?: Array<{ name: string; resources?: KubeContainerResources }>
}

interface KubePodMetrics {
  containers?: Array<{ name: string; usage?: { cpu?: string; memory?: string } }>
}

export class PlatformK8sRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'kubernetes'
  // Image lives in a registry and is pulled by the cluster on pod creation.
  static readonly requiresLocalImage = false

  constructor(config: ContainerConfig) {
    super(config)
  }

  protected getRunnerCommand(): string {
    return 'kubernetes'
  }

  static isEligible(): boolean {
    return isRunningInKubernetes()
  }

  static async isAvailable(): Promise<boolean> {
    // HOST_PUBLIC_URL is required: container-manager always calls
    // getHostApiBaseUrl(), which throws without it.
    return Boolean(resolveKubeConfigOrNull()) && Boolean(process.env.HOST_PUBLIC_URL?.trim())
  }

  static async isRunning(): Promise<boolean> {
    return this.isAvailable()
  }

  async start(options?: StartOptions): Promise<void> {
    const info = await this.getInfoFromRuntime()
    if (info.status === 'running') {
      return
    }

    const kube = getKubeConfig()
    // Owner = our own host-app pod, so the cluster GCs the agent pod/service if
    // host-app dies (covers the crash path stopSync() can't clean up).
    const ownerRef = await resolveOwnerReference(kube.namespace)
    await deleteResource(`/api/v1/namespaces/${kube.namespace}/pods/${this.podName()}`)
    await deleteResource(`/api/v1/namespaces/${kube.namespace}/services/${this.serviceName()}`)
    await createResource(`/api/v1/namespaces/${kube.namespace}/services`, buildAgentServiceManifest(kube, this.serviceName(), this.podName(), ownerRef))
    await createResource(`/api/v1/namespaces/${kube.namespace}/pods`, buildAgentPodManifest(kube, this.podName(), this.config, options?.envVars ?? {}, ownerRef))

    await waitForPodReady(kube.namespace, this.podName(), 300_000)

    if (!(await this.waitForHealthy(60_000, CONTAINER_INTERNAL_PORT))) {
      const logs = await this.getLogs(30)
      const logsSnippet = logs ? `\n\nPod logs:\n${logs}` : ''
      await this.teardownResources(kube.namespace)
      throw new Error(`Platform k8s agent pod ${this.podName()} failed to become healthy${logsSnippet}`)
    }
  }

  async stop(_options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    const { namespace } = getKubeConfig()
    await this.teardownResources(namespace)
    await waitForPodGone(namespace, this.podName(), 60_000)
    return { forceStopUsed: false, stopped: true }
  }

  private async teardownResources(namespace: string): Promise<void> {
    await deleteResource(`/api/v1/namespaces/${namespace}/pods/${this.podName()}`)
    await deleteResource(`/api/v1/namespaces/${namespace}/services/${this.serviceName()}`)
  }

  stopSync(): void {
    // Pod/service teardown uses the async-only in-cluster API; sync shutdown only tears down WS connections.
    this.terminateWebSocketConnections()
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const { namespace } = getKubeConfig()
    try {
      const pod = await requestJson<{ metadata?: { deletionTimestamp?: string }; status?: KubePodStatus }>('GET', `/api/v1/namespaces/${namespace}/pods/${this.podName()}`, undefined, [200])
      // A Terminating pod keeps phase=Running until its container exits; treat it
      // as stopped so it is never routed to or cached as running.
      if (pod.metadata?.deletionTimestamp) return { status: 'stopped', port: null }
      const phase = pod.status?.phase
      const ready = pod.status?.containerStatuses?.some((status) => status.ready === true)
      if (phase === 'Running' && ready) return { status: 'running', port: CONTAINER_INTERNAL_PORT }
      return { status: 'stopped', port: null }
    } catch (error) {
      if (!(error instanceof KubeApiError && error.statusCode === 404)) {
        captureException(error, {
          tags: { area: 'container', op: 'k8s.getInfo' },
          extra: { podName: this.podName() },
        })
      }
      return { status: 'stopped', port: null }
    }
  }

  async getLogs(tail: number = 50): Promise<string> {
    const { namespace } = getKubeConfig()
    try {
      return await requestText(
        'GET',
        `/api/v1/namespaces/${namespace}/pods/${this.podName()}/log?container=agent&tailLines=${tail}`,
      )
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'k8s.getLogs' },
        extra: { podName: this.podName(), tail },
      })
      return ''
    }
  }

  async getStats(): Promise<ContainerStats | null> {
    const info = await this.getInfoFromRuntime()
    if (info.status !== 'running') return null

    const { namespace } = getKubeConfig()
    const podName = this.podName()
    try {
      const [metrics, pod] = await Promise.all([
        requestJson<KubePodMetrics>(
          'GET',
          `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${podName}`,
        ),
        requestJson<{ spec?: KubePodSpec }>('GET', `/api/v1/namespaces/${namespace}/pods/${podName}`),
      ])
      const usage = metrics.containers?.find((c) => c.name === 'agent')?.usage
      const limits = pod.spec?.containers?.find((c) => c.name === 'agent')?.resources?.limits
      if (!usage?.memory || !limits?.memory) return null

      const memoryUsageBytes = parseKubernetesMemoryBytes(usage.memory)
      const memoryLimitBytes = parseKubernetesMemoryBytes(limits.memory)
      const memoryPercent = memoryLimitBytes > 0
        ? (memoryUsageBytes / memoryLimitBytes) * 100
        : 0
      const cpuUsageCores = usage.cpu ? parseKubernetesCpuCores(usage.cpu) : 0
      const cpuLimitCores = limits.cpu ? parseKubernetesCpuCores(limits.cpu) : 0
      const cpuPercent = cpuLimitCores > 0 ? (cpuUsageCores / cpuLimitCores) * 100 : 0

      return { memoryUsageBytes, memoryLimitBytes, memoryPercent, cpuPercent }
    } catch (error) {
      // metrics-server is optional; 404 means stats are unavailable, not a bug.
      if (!(error instanceof KubeApiError && (error.statusCode === 404 || error.statusCode === 403))) {
        captureException(error, {
          tags: { area: 'container', op: 'k8s.getStats' },
          extra: { podName },
        })
      }
      return null
    }
  }

  public buildVolumeFlag(_hostPath: string, _containerPath: string): string {
    return ''
  }

  protected getBaseUrl(port: number): string {
    const { namespace } = getKubeConfig()
    return `http://${this.serviceName()}.${namespace}.svc.cluster.local:${port}`
  }

  public getWebSocketBaseUrl(port: number): string {
    const { namespace } = getKubeConfig()
    return `ws://${this.serviceName()}.${namespace}.svc.cluster.local:${port}`
  }

  public getHostApiBaseUrl(): string {
    const publicUrl = process.env.HOST_PUBLIC_URL?.replace(/\/+$/, '')
    if (!publicUrl) {
      throw new Error('HOST_PUBLIC_URL is required for the platform k8s runtime')
    }
    return publicUrl
  }

  private podName(): string {
    return kubeResourceName('superagent', this.config.agentId)
  }

  private serviceName(): string {
    return this.podName()
  }
}

export function buildAgentServiceManifest(kube: KubeConfig, serviceName: string, podName: string, ownerRef?: OwnerReference | null): KubeResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace: kube.namespace,
      labels: agentResourceLabels(kube, podName),
      ...(ownerRef ? { ownerReferences: [ownerRef] } : {}),
    },
    spec: {
      // Select only on the runtime-owned unique instance label so routing is
      // self-contained regardless of any externally injected labels.
      selector: { [INSTANCE_LABEL]: podName },
      ports: [{ name: 'http', port: CONTAINER_INTERNAL_PORT, targetPort: CONTAINER_INTERNAL_PORT }],
    },
  }
}

export function buildAgentPodManifest(
  kube: KubeConfig,
  podName: string,
  config: ContainerConfig,
  envVars: Record<string, string>,
  ownerRef?: OwnerReference | null,
): KubeResource {
  const settings = getSettings()
  const image = process.env.K8S_AGENT_IMAGE || settings.container.agentImage
  const mergedEnvVars: Record<string, string | undefined> = {
    ...getActiveLlmProvider().getContainerEnvVars(),
    CLAUDE_CONFIG_DIR: '/workspace/.claude',
    ENABLE_TOOL_SEARCH: settings.enableToolSearch !== false ? 'true' : 'false',
    ...config.envVars,
    ...envVars,
  }
  const env = Object.entries(mergedEnvVars)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ({ name, value }))
  const resources = buildAgentContainerResources(settings.container.resourceLimits)

  const spec: Record<string, unknown> = {
    automountServiceAccountToken: false,
    restartPolicy: 'Never',
    // Harden the only pod that runs agent-driven arbitrary code: fail closed if
    // the image ever ships without a non-root USER, and confine the syscall
    // surface (shrinks the container-escape path to the node).
    securityContext: {
      runAsNonRoot: true,
      runAsUser: AGENT_RUN_AS_UID,
      runAsGroup: AGENT_RUN_AS_UID,
      fsGroup: AGENT_RUN_AS_UID,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [{
      name: 'agent',
      image,
      env,
      ports: [{ containerPort: CONTAINER_INTERNAL_PORT }],
      resources,
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
      volumeMounts: [{
        name: 'workspaces',
        mountPath: '/workspace',
        subPath: workspaceSubPath(kube.workspaceSubPathPrefix, config.agentId),
      }],
    }],
    volumes: [{
      name: 'workspaces',
      persistentVolumeClaim: { claimName: kube.pvcName },
    }],
  }
  if (kube.imagePullSecretName) {
    spec.imagePullSecrets = [{ name: kube.imagePullSecretName }]
  }

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: kube.namespace,
      labels: agentResourceLabels(kube, podName),
      ...(ownerRef ? { ownerReferences: [ownerRef] } : {}),
      annotations: {
        ...kube.extraAnnotations,
        [AGENT_ID_ANNOTATION]: config.agentId,
      },
    },
    spec,
  }
}

export interface ContainerResourceLimits {
  cpu: number
  memory: string
}

export function buildAgentContainerResources(limits: ContainerResourceLimits): {
  requests: { cpu: string; memory: string }
  limits: { cpu: string; memory: string }
} {
  const cpu = formatKubernetesCpu(limits.cpu)
  const memory = toKubernetesMemoryQuantity(limits.memory)
  // Match Docker `--cpus` / `--memory`: same requests and limits (Guaranteed QoS).
  return {
    requests: { cpu, memory },
    limits: { cpu, memory },
  }
}

export function formatKubernetesCpu(cpu: number): string {
  if (!Number.isFinite(cpu) || cpu <= 0) return '1'
  if (Number.isInteger(cpu)) return String(cpu)
  return `${Math.round(cpu * 1000)}m`
}

export function parseKubernetesCpuCores(cpu: string): number {
  const trimmed = cpu.trim()
  if (trimmed.endsWith('m')) {
    return parseFloat(trimmed.slice(0, -1)) / 1000
  }
  const cores = parseFloat(trimmed)
  return Number.isFinite(cores) ? cores : 0
}

export function parseKubernetesMemoryBytes(memory: string): number {
  const trimmed = memory.trim()
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/i)
  if (!match) return 0
  const value = parseFloat(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  const binaryMultipliers: Record<string, number> = {
    '': 1,
    k: 1000, ki: 1024,
    m: 1000 ** 2, mi: 1024 ** 2,
    g: 1000 ** 3, gi: 1024 ** 3,
    t: 1000 ** 4, ti: 1024 ** 4,
  }
  return Math.round(value * (binaryMultipliers[unit] ?? 1))
}

export function toKubernetesMemoryQuantity(memory: string): string {
  const trimmed = memory.trim()
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/)
  if (!match) return trimmed
  const value = match[1]
  const unit = (match[2] ?? '').toLowerCase()
  switch (unit) {
    case 'm':
    case 'mb':
      return `${value}Mi`
    case 'g':
    case 'gb':
      return `${value}Gi`
    case 'gi':
    case 'gib':
      return `${value}Gi`
    case 'mi':
    case 'mib':
      return `${value}Mi`
    case 'ki':
    case 'kib':
      return `${value}Ki`
    default:
      return trimmed
  }
}

function getKubeConfig(): KubeConfig {
  const resolved = resolveKubeConfigOrNull()
  if (!resolved) {
    throw new Error('K8S_NAMESPACE and K8S_WORKSPACES_PVC are required for the platform k8s runtime')
  }
  return resolved
}

let memoizedKubeConfig: KubeConfig | null = null

export function resolveKubeConfigOrNull(): KubeConfig | null {
  if (memoizedKubeConfig) return memoizedKubeConfig
  memoizedKubeConfig = computeKubeConfigOrNull()
  return memoizedKubeConfig
}

export function resetPlatformK8sRuntimeStateForTests(): void {
  memoizedKubeConfig = null
  memoizedOwnerRef = undefined
}

function computeKubeConfigOrNull(): KubeConfig | null {
  const namespace = process.env.K8S_NAMESPACE
    || readOptionalFile(SERVICE_ACCOUNT_NAMESPACE_PATH)
  const pvcName = process.env.K8S_WORKSPACES_PVC
  if (!namespace || !pvcName) {
    return null
  }
  return {
    namespace,
    pvcName,
    workspaceSubPathPrefix: trimSlashes(process.env.K8S_WORKSPACES_SUBPATH_PREFIX || ''),
    imagePullSecretName: process.env.K8S_IMAGE_PULL_SECRET_NAME?.trim() || null,
    extraLabels: parseLabelMapEnv('K8S_EXTRA_LABELS'),
    extraAnnotations: parseStringMapEnv('K8S_EXTRA_ANNOTATIONS'),
  }
}

function agentResourceLabels(kube: KubeConfig, podName: string): Record<string, string> {
  // Runtime-owned keys spread last so extraLabels can never override them.
  return {
    ...kube.extraLabels,
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [COMPONENT_LABEL]: COMPONENT_VALUE,
    [INSTANCE_LABEL]: podName,
  }
}

function workspaceSubPath(prefix: string, agentId: string): string {
  const tail = `${agentId}/workspace`
  return prefix ? `${prefix}/${tail}` : tail
}

const stringMapSchema = z.record(z.string(), z.string())

function parseStringMapEnv(envName: string): Record<string, string> {
  const raw = process.env[envName]?.trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    captureException(error, { tags: { area: 'container', op: 'k8s.parseEnvJson' }, extra: { envName } })
    return {}
  }
  const result = stringMapSchema.safeParse(parsed)
  if (!result.success) {
    captureException(result.error, { tags: { area: 'container', op: 'k8s.parseEnvJson' }, extra: { envName } })
    return {}
  }
  return result.data
}

function parseLabelMapEnv(envName: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseStringMapEnv(envName))) {
    if (isValidLabelValue(value)) {
      out[key] = value
    } else {
      captureException(new Error(`Dropping invalid k8s label value for "${key}"`), {
        tags: { area: 'container', op: 'k8s.parseLabel' }, extra: { envName, key },
      })
    }
  }
  return out
}

function isValidLabelValue(value: string): boolean {
  if (value.length === 0) return true
  if (value.length > 63) return false
  return /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(value)
}

export function kubeResourceName(prefix: string, value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8)
  const maxBaseLength = 63 - prefix.length - hash.length - 2
  const base = sanitized.slice(0, maxBaseLength).replace(/-+$/g, '') || 'agent'
  return `${prefix}-${base}-${hash}`
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || null
  } catch {
    return null
  }
}

let memoizedOwnerRef: OwnerReference | null | undefined

// host-app's own pod identity is constant for the process lifetime, so resolve once.
async function resolveOwnerReference(namespace: string): Promise<OwnerReference | null> {
  if (memoizedOwnerRef !== undefined) return memoizedOwnerRef
  memoizedOwnerRef = await computeOwnerReference(namespace)
  return memoizedOwnerRef
}

async function computeOwnerReference(namespace: string): Promise<OwnerReference | null> {
  // kubelet sets HOSTNAME to the pod name; K8S_POD_NAME (downward API) overrides it.
  const podName = process.env.K8S_POD_NAME || process.env.HOSTNAME
  if (!podName) return null
  try {
    const pod = await requestJson<{ metadata?: { uid?: string } }>('GET', `/api/v1/namespaces/${namespace}/pods/${podName}`)
    const uid = pod.metadata?.uid
    if (!uid) return null
    return { apiVersion: 'v1', kind: 'Pod', name: podName, uid, controller: false, blockOwnerDeletion: false }
  } catch (error) {
    // Degrade to no GC wiring rather than blocking agent start.
    captureException(error, { tags: { area: 'container', op: 'k8s.resolveOwnerRef' }, extra: { podName } })
    return null
  }
}

async function waitForPodReady(namespace: string, podName: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const pod = await requestJson<{ status?: KubePodStatus }>('GET', `/api/v1/namespaces/${namespace}/pods/${podName}`, undefined, [200])
    if (pod.status?.phase === 'Running' && pod.status.containerStatuses?.some((status) => status.ready === true)) {
      return
    }
    if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
      throw new Error(`Platform k8s agent pod ${podName} exited before becoming ready`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for platform k8s agent pod ${podName} to become ready`)
}

async function waitForPodGone(namespace: string, podName: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await requestJson('GET', `/api/v1/namespaces/${namespace}/pods/${podName}`, undefined, [200])
    } catch (error) {
      if (error instanceof KubeApiError && error.statusCode === 404) return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for platform k8s agent pod ${podName} to terminate`)
}

// statusCode 0 = transport/network failure (no HTTP response).
export class KubeApiError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message)
    this.name = 'KubeApiError'
  }
}

export interface RetryPolicy {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  retryableStatuses: number[]
}

const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseDelayMs: 500, maxDelayMs: 5_000, retryableStatuses: [429, 500, 502, 503, 504] }
// Pod create races a still-Terminating same-name pod (409). Retry long enough to
// outlast the default 30s termination grace, plus the usual transient 5xx set.
const CREATE_RETRY: RetryPolicy = { attempts: 8, baseDelayMs: 1_000, maxDelayMs: 8_000, retryableStatuses: [409, 429, 500, 502, 503, 504] }

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const retryable = error instanceof KubeApiError
        && (error.statusCode === 0 || policy.retryableStatuses.includes(error.statusCode))
      if (!retryable || attempt >= policy.attempts) throw error
      await sleep(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)))
    }
  }
}

async function createResource(path: string, body: KubeResource): Promise<void> {
  await withRetry(() => requestJsonOnce('POST', path, body, [200, 201]), CREATE_RETRY)
}

async function deleteResource(path: string): Promise<void> {
  await withRetry(() => requestJsonOnce('DELETE', path, undefined, [200, 202, 404]), DEFAULT_RETRY)
}

async function requestJson<T = unknown>(
  method: string,
  requestPath: string,
  body?: unknown,
  expectedStatuses: number[] = [200],
): Promise<T> {
  return withRetry(() => requestJsonOnce<T>(method, requestPath, body, expectedStatuses), DEFAULT_RETRY)
}

async function requestText(
  method: string,
  requestPath: string,
  expectedStatuses: number[] = [200],
): Promise<string> {
  return withRetry(
    () => requestOnce(method, requestPath, undefined, expectedStatuses).then((r) => r.body),
    DEFAULT_RETRY,
  )
}

async function requestOnce(
  method: string,
  requestPath: string,
  body?: unknown,
  expectedStatuses: number[] = [200],
): Promise<{ statusCode: number; body: string }> {
  const token = readOptionalFile(SERVICE_ACCOUNT_TOKEN_PATH)
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT || '443'
  if (!token || !host) {
    throw new Error('Kubernetes service account token and KUBERNETES_SERVICE_HOST are required')
  }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = https.request({
      host,
      port,
      path: requestPath,
      method,
      ca: readOptionalFile(SERVICE_ACCOUNT_CA_PATH) ?? undefined,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let responseBody = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { responseBody += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }))
    })
    req.on('error', (error) => reject(new KubeApiError(`Kubernetes API ${method} ${requestPath} transport error: ${error.message}`, 0)))
    if (payload) req.write(payload)
    req.end()
  })
  if (!expectedStatuses.includes(response.statusCode)) {
    throw new KubeApiError(`Kubernetes API ${method} ${requestPath} failed (${response.statusCode}): ${response.body}`, response.statusCode)
  }
  return response
}

export async function requestJsonOnce<T = unknown>(
  method: string,
  requestPath: string,
  body?: unknown,
  expectedStatuses: number[] = [200],
): Promise<T> {
  const response = await requestOnce(method, requestPath, body, expectedStatuses)
  if (!response.body) return undefined as T
  try {
    return JSON.parse(response.body) as T
  } catch (error) {
    throw new Error(`Kubernetes API ${method} ${requestPath} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
