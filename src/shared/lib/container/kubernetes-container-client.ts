import { createHash } from 'crypto'
import fs from 'fs'
import https from 'https'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, StartOptions, StopOptions } from './types'
import { getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount'
const SERVICE_ACCOUNT_TOKEN_PATH = `${SERVICE_ACCOUNT_DIR}/token`
const SERVICE_ACCOUNT_CA_PATH = `${SERVICE_ACCOUNT_DIR}/ca.crt`
const SERVICE_ACCOUNT_NAMESPACE_PATH = `${SERVICE_ACCOUNT_DIR}/namespace`
const AGENT_LABEL_KEY = 'superagent.ai/agent'
const COMPONENT_LABEL_KEY = 'gamut.cloud/component'
const COMPONENT_LABEL_VALUE = 'agent-container'

export interface KubeConfig {
  namespace: string
  pvcName: string
  orgSlug: string
  orgId: string | null
  runtimeVersion: string | null
  workspaceSubPathPrefix: string
  imagePullSecretName: string | null
}

type KubeMetadata = {
  name: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
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

export class KubernetesContainerClient extends BaseContainerClient {
  static readonly runnerName = 'kubernetes'

  constructor(config: ContainerConfig) {
    super(config)
  }

  protected getRunnerCommand(): string {
    return 'kubernetes'
  }

  static isEligible(): boolean {
    return process.env.REMOTE_RUNTIME === 'kubernetes' || Boolean(process.env.K8S_NAMESPACE)
  }

  static async isAvailable(): Promise<boolean> {
    return Boolean(resolveKubeConfigOrNull())
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
    await assertNamespaceNotUpgrading(kube)
    await deleteResource(`/api/v1/namespaces/${kube.namespace}/pods/${this.podName()}`)
    await deleteResource(`/api/v1/namespaces/${kube.namespace}/services/${this.serviceName()}`)
    await createResource(`/api/v1/namespaces/${kube.namespace}/services`, buildAgentServiceManifest(kube, this.serviceName(), this.podName()))
    await createResource(`/api/v1/namespaces/${kube.namespace}/pods`, buildAgentPodManifest(kube, this.podName(), this.config, options?.envVars ?? {}))

    await waitForPodReady(kube.namespace, this.podName(), 300_000)

    if (!(await this.waitForHealthy(60_000, CONTAINER_INTERNAL_PORT))) {
      throw new Error(`Kubernetes agent pod ${this.podName()} failed to become healthy`)
    }
  }

  async stop(_options?: StopOptions): Promise<{ forceStopUsed: boolean }> {
    const { namespace } = getKubeConfig()
    await deleteResource(`/api/v1/namespaces/${namespace}/pods/${this.podName()}`)
    await deleteResource(`/api/v1/namespaces/${namespace}/services/${this.serviceName()}`)
    return { forceStopUsed: false }
  }

  stopSync(): void {
    // The in-cluster Kubernetes API is async-only; process shutdown cleanup is best-effort elsewhere.
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const { namespace } = getKubeConfig()
    try {
      const pod = await requestJson<{ status?: KubePodStatus }>('GET', `/api/v1/namespaces/${namespace}/pods/${this.podName()}`, undefined, [200])
      const phase = pod.status?.phase
      const ready = pod.status?.containerStatuses?.some((status) => status.ready === true)
      if (phase === 'Running' && ready) return { status: 'running', port: CONTAINER_INTERNAL_PORT }
      return { status: 'stopped', port: null }
    } catch {
      return { status: 'stopped', port: null }
    }
  }

  async getStats(): Promise<ContainerStats | null> {
    return null
  }

  public buildVolumeFlag(_hostPath: string, _containerPath: string): string {
    return ''
  }

  protected getBaseUrl(port: number): string {
    const { namespace } = getKubeConfig()
    return `http://${this.serviceName()}.${namespace}.svc.cluster.local:${port}`
  }

  protected getWebSocketBaseUrl(port: number): string {
    const { namespace } = getKubeConfig()
    return `ws://${this.serviceName()}.${namespace}.svc.cluster.local:${port}`
  }

  private podName(): string {
    return kubeResourceName('superagent', this.config.agentId)
  }

  private serviceName(): string {
    return this.podName()
  }
}

export function buildAgentServiceManifest(kube: KubeConfig, serviceName: string, podName: string): KubeResource {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace: kube.namespace,
      labels: commonLabels(kube, podName),
    },
    spec: {
      selector: { app: podName, [COMPONENT_LABEL_KEY]: COMPONENT_LABEL_VALUE },
      ports: [{ name: 'http', port: CONTAINER_INTERNAL_PORT, targetPort: CONTAINER_INTERNAL_PORT }],
    },
  }
}

export function buildAgentPodManifest(
  kube: KubeConfig,
  podName: string,
  config: ContainerConfig,
  envVars: Record<string, string>,
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

  const spec: Record<string, unknown> = {
    automountServiceAccountToken: false,
    restartPolicy: 'Never',
    containers: [{
      name: 'agent',
      image,
      env,
      ports: [{ containerPort: CONTAINER_INTERNAL_PORT }],
      volumeMounts: [{
        name: 'workspaces',
        mountPath: '/workspace',
        subPath: `${kube.workspaceSubPathPrefix}/${sanitizePathSegment(config.agentId)}`,
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
      labels: commonLabels(kube, podName),
      annotations: {
        'superagent.ai/agent-id': config.agentId,
      },
    },
    spec,
  }
}

function getKubeConfig(): KubeConfig {
  const resolved = resolveKubeConfigOrNull()
  if (!resolved) {
    throw new Error('K8S_NAMESPACE and K8S_WORKSPACES_PVC are required for REMOTE_RUNTIME=kubernetes')
  }
  return resolved
}

function resolveKubeConfigOrNull(): KubeConfig | null {
  const namespace = process.env.K8S_NAMESPACE
    || readOptionalFile(SERVICE_ACCOUNT_NAMESPACE_PATH)
  const pvcName = process.env.K8S_WORKSPACES_PVC
  if (!namespace || !pvcName) {
    return null
  }
  const orgSlug = process.env.K8S_ORG_SLUG || namespace
  const deploymentId = process.env.K8S_DEPLOYMENT_ID || process.env.GAMUT_DEPLOYMENT_ID
  const workspaceSubPathPrefix = process.env.K8S_WORKSPACES_SUBPATH_PREFIX
    || process.env.K8S_WORKSPACE_SUBPATH_PREFIX
    || (deploymentId ? `${deploymentId}/${orgSlug}/workspaces` : null)
    || 'workspaces'
  const imagePullSecretName = process.env.K8S_IMAGE_PULL_SECRET_NAME ?? 'ghcr-pull-secret'
  return {
    namespace,
    pvcName,
    orgSlug,
    orgId: process.env.GAMUT_ORG_ID ?? null,
    runtimeVersion: process.env.GAMUT_RUNTIME_VERSION ?? null,
    workspaceSubPathPrefix: trimSlashes(workspaceSubPathPrefix),
    imagePullSecretName: imagePullSecretName.trim() || null,
  }
}

function commonLabels(kube: KubeConfig, podName: string): Record<string, string> {
  return {
    app: podName,
    [COMPONENT_LABEL_KEY]: COMPONENT_LABEL_VALUE,
    'superagent.ai/runtime': 'kubernetes',
    [AGENT_LABEL_KEY]: podName,
    'gamut.cloud/k8s-slug': sanitizeLabelValue(kube.orgSlug),
    ...(kube.orgId ? { 'gamut.cloud/org-id': sanitizeLabelValue(kube.orgId) } : {}),
    ...(kube.runtimeVersion ? { 'gamut.cloud/runtime-version': sanitizeLabelValue(kube.runtimeVersion) } : {}),
  }
}

function kubeResourceName(prefix: string, value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8)
  const maxBaseLength = 63 - prefix.length - hash.length - 2
  const base = sanitized.slice(0, maxBaseLength).replace(/-+$/g, '') || 'agent'
  return `${prefix}-${base}-${hash}`
}

function sanitizeLabelValue(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
  if (sanitized.length <= 63) return sanitized || 'unknown'
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `${sanitized.slice(0, 54).replace(/[^A-Za-z0-9]+$/g, '')}-${hash}`
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return sanitized || 'agent'
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

async function assertNamespaceNotUpgrading(kube: KubeConfig): Promise<void> {
  try {
    const ns = await requestJson<{ metadata?: KubeMetadata }>('GET', `/api/v1/namespaces/${kube.namespace}`, undefined, [200])
    if (ns.metadata?.annotations?.['gamut.cloud/upgrading'] === 'true') {
      throw new Error('Runtime is upgrading. Please retry after the upgrade completes.')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Runtime is upgrading')) throw error
    console.warn('[KubernetesContainerClient] unable to read namespace upgrade annotation:', error)
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
      throw new Error(`Kubernetes agent pod ${podName} exited before becoming ready`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`Timed out waiting for Kubernetes agent pod ${podName} to become ready`)
}

async function createResource(path: string, body: KubeResource): Promise<void> {
  await requestJson('POST', path, body, [200, 201])
}

async function deleteResource(path: string): Promise<void> {
  await requestJson('DELETE', path, undefined, [200, 202, 404])
}

async function requestJson<T = unknown>(
  method: string,
  requestPath: string,
  body?: unknown,
  expectedStatuses: number[] = [200],
): Promise<T> {
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
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
  if (!expectedStatuses.includes(response.statusCode)) {
    throw new Error(`Kubernetes API ${method} ${requestPath} failed (${response.statusCode}): ${response.body}`)
  }
  if (!response.body) return undefined as T
  try {
    return JSON.parse(response.body) as T
  } catch (error) {
    throw new Error(`Kubernetes API ${method} ${requestPath} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
