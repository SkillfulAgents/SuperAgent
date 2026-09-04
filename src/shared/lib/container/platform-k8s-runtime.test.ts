import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ContainerConfig } from './types'
import https from 'https'
import fs from 'fs'
import { EventEmitter } from 'events'

const mockGetSettings = vi.fn()
const mockCaptureException = vi.fn()
const { mockStorageSubPath } = vi.hoisted(() => ({ mockStorageSubPath: vi.fn((_p: string): string | null => null) }))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}))
vi.mock('@shared/lib/config/data-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/config/data-dir')>()),
  getAgentWorkspaceDir: (id: string) => `/data/agents/${id}/workspace`,
  storageSubPath: (p: string) => mockStorageSubPath(p),
}))

vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({
    getContainerEnvVars: () => ({ ANTHROPIC_API_KEY: 'test-key' }),
  }),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import {
  PlatformK8sRuntimeClient,
  buildAgentContainerResources,
  buildAgentPodManifest,
  buildAgentServiceManifest,
  kubeResourceName,
  parseKubernetesCpuCores,
  parseKubernetesMemoryBytes,
  resolveKubeConfigOrNull,
  resetPlatformK8sRuntimeStateForTests,
  requestJsonOnce,
  toKubernetesMemoryQuantity,
  acceptCloudMounts,
  withRetry,
  KubeApiError,
  type KubeConfig,
  type OwnerReference,
} from './platform-k8s-runtime'
import type { AgentMount } from '@shared/lib/types/mount'

const kube: KubeConfig = {
  namespace: 'org-abc123',
  pvcName: 'org-data',
  imagePullSecretName: 'ghcr-pull-secret',
  extraLabels: {
    'gamut.cloud/component': 'agent-container',
    'gamut.cloud/org-id': 'org_abc123',
  },
  extraAnnotations: { 'gamut.cloud/deployment-id': 'staging-usw2' },
}

const record = (over: Partial<AgentMount>): AgentMount => ({
  id: 'v1', hostPath: '/data/volumes/v1', containerPath: '/volumes/team-brain', folderName: 'Team brain', addedAt: '2026-01-01', ...over,
})

const KUBE_ENV_KEYS = [
  'K8S_NAMESPACE',
  'K8S_WORKSPACES_PVC',
  'K8S_IMAGE_PULL_SECRET_NAME',
  'K8S_EXTRA_LABELS',
  'K8S_EXTRA_ANNOTATIONS',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'HOST_PUBLIC_URL',
] as const

function installHttpsMock(handler: (method: string, path: string, body: string) => { statusCode: number; body: string }) {
  vi.spyOn(https, 'request').mockImplementation(((opts, callback) => {
    const path = String((opts as { path?: string }).path ?? '')
    const method = String((opts as { method?: string }).method ?? 'GET')
    const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: ReturnType<typeof vi.fn> }
    res.setEncoding = vi.fn()
    const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
    let written = ''
    req.write = vi.fn((chunk: unknown) => { written += String(chunk ?? '') })
    req.end = vi.fn((chunk?: unknown) => {
      if (chunk !== undefined) written += String(chunk)
      const { statusCode, body } = handler(method, path, written)
      res.statusCode = statusCode
      process.nextTick(() => {
        res.emit('data', body)
        res.emit('end')
      })
    })
    if (typeof callback === 'function') callback(res as any)
    return req as any
  }) as typeof https.request)
}

describe('PlatformK8sRuntimeClient manifests', () => {
  beforeEach(() => {
    mockGetSettings.mockReturnValue({
      container: { agentImage: 'settings-agent-image', resourceLimits: { cpu: 2, memory: '4g' } },
      enableToolSearch: true,
    })
    mockStorageSubPath.mockImplementation((p) => p.startsWith('/data/') ? p.slice('/data/'.length) : null)
    process.env.K8S_AGENT_IMAGE = 'k8s-agent-image'
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    delete process.env.K8S_AGENT_IMAGE
  })

  it('builds agent pod manifest with runtime-owned labels, injected metadata, and workspace subPath', () => {
    const config: ContainerConfig = {
      agentId: 'agent-with-spaces',
      envVars: { EXTRA_ENV: 'extra' },
    }

    // buildAgentPodManifest is a pure serializer now: it maps the FINAL env
    // (built by the client via buildAgentEnv) into pod env entries. Pass the
    // already-merged env and assert it round-trips.
    const pod = buildAgentPodManifest(kube, 'superagent-agent-with-spaces-12345678', config, {
      ANTHROPIC_API_KEY: 'test-key',
      EXTRA_ENV: 'extra',
      RUNTIME_ENV: 'runtime',
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
    })

    expect(pod.metadata.labels).toEqual({
      'app.kubernetes.io/managed-by': 'superagent',
      'app.kubernetes.io/component': 'agent',
      'app.kubernetes.io/instance': 'superagent-agent-with-spaces-12345678',
      'gamut.cloud/component': 'agent-container',
      'gamut.cloud/org-id': 'org_abc123',
    })
    expect(pod.metadata.annotations).toEqual({
      'superagent.ai/agent-id': 'agent-with-spaces',
      'gamut.cloud/deployment-id': 'staging-usw2',
    })
    expect(pod.spec?.automountServiceAccountToken).toBe(false)
    expect(pod.spec?.imagePullSecrets).toEqual([{ name: 'ghcr-pull-secret' }])
    expect(pod.spec?.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    })

    const container = (pod.spec?.containers as Array<any>)[0]
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
    })
    expect(container.image).toBe('k8s-agent-image')
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'ANTHROPIC_API_KEY', value: 'test-key' },
      { name: 'EXTRA_ENV', value: 'extra' },
      { name: 'RUNTIME_ENV', value: 'runtime' },
      { name: 'CLAUDE_CONFIG_DIR', value: '/workspace/.claude' },
    ]))
    expect(container.volumeMounts[0]).toMatchObject({
      mountPath: '/workspace',
      subPath: 'agents/agent-with-spaces/workspace',
    })
    expect(container.resources).toEqual({
      requests: { cpu: '2', memory: '4Gi' },
      limits: { cpu: '2', memory: '4Gi' },
    })
  })

  it('uses settings resourceLimits in the pod manifest', () => {
    mockGetSettings.mockReturnValue({
      container: { agentImage: 'settings-agent-image', resourceLimits: { cpu: 4, memory: '8g' } },
      enableToolSearch: true,
    })
    const pod = buildAgentPodManifest(kube, 'superagent-a', { agentId: 'a', envVars: {} }, {})
    const container = (pod.spec?.containers as Array<{ resources: unknown }>)[0]
    expect(container.resources).toEqual({
      requests: { cpu: '4', memory: '8Gi' },
      limits: { cpu: '4', memory: '8Gi' },
    })
  })

  it('converts docker-style memory units to kubernetes quantities', () => {
    expect(toKubernetesMemoryQuantity('512m')).toBe('512Mi')
    expect(toKubernetesMemoryQuantity('4g')).toBe('4Gi')
    expect(buildAgentContainerResources({ cpu: 1.5, memory: '2g' })).toEqual({
      requests: { cpu: '1500m', memory: '2Gi' },
      limits: { cpu: '1500m', memory: '2Gi' },
    })
  })

  it('selects the pod via the runtime-owned instance label only', () => {
    const service = buildAgentServiceManifest(kube, 'superagent-a', 'superagent-a')

    expect(service.spec?.selector).toEqual({ 'app.kubernetes.io/instance': 'superagent-a' })
    expect(service.metadata.labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'superagent',
      'gamut.cloud/component': 'agent-container',
    })
    expect(service.spec?.ports).toEqual([{ name: 'http', port: 3000, targetPort: 3000 }])
  })

  it('never lets extraLabels or extraAnnotations override runtime-owned metadata', () => {
    const hostile: KubeConfig = {
      ...kube,
      extraLabels: {
        'app.kubernetes.io/managed-by': 'attacker',
        'app.kubernetes.io/component': 'attacker',
        'app.kubernetes.io/instance': 'attacker',
        'gamut.cloud/org-id': 'org_abc123',
      },
      extraAnnotations: {
        'superagent.ai/agent-id': 'attacker',
        'gamut.cloud/deployment-id': 'staging-usw2',
      },
    }

    const pod = buildAgentPodManifest(hostile, 'superagent-a', { agentId: 'a', envVars: {} }, {})
    expect(pod.metadata.labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'superagent',
      'app.kubernetes.io/component': 'agent',
      'app.kubernetes.io/instance': 'superagent-a',
      'gamut.cloud/org-id': 'org_abc123',
    })
    expect(pod.metadata.annotations).toMatchObject({
      'superagent.ai/agent-id': 'a',
      'gamut.cloud/deployment-id': 'staging-usw2',
    })

    const service = buildAgentServiceManifest(hostile, 'superagent-a', 'superagent-a')
    expect(service.metadata.labels).toMatchObject({
      'app.kubernetes.io/managed-by': 'superagent',
      'app.kubernetes.io/instance': 'superagent-a',
    })
    expect(service.spec?.selector).toEqual({ 'app.kubernetes.io/instance': 'superagent-a' })
  })

  it('stamps ownerReferences on pod and service for cluster GC when provided', () => {
    const owner: OwnerReference = {
      apiVersion: 'v1', kind: 'Pod', name: 'host-app-xyz', uid: 'uid-123',
      controller: false, blockOwnerDeletion: false,
    }
    const pod = buildAgentPodManifest(kube, 'superagent-a', { agentId: 'a', envVars: {} }, {}, owner)
    const service = buildAgentServiceManifest(kube, 'superagent-a', 'superagent-a', owner)

    expect(pod.metadata.ownerReferences).toEqual([owner])
    expect(service.metadata.ownerReferences).toEqual([owner])
  })

  it('omits ownerReferences when none is resolved', () => {
    const pod = buildAgentPodManifest(kube, 'superagent-a', { agentId: 'a', envVars: {} }, {}, null)
    expect(pod.metadata.ownerReferences).toBeUndefined()
  })

  it('mounts accepted records as PVC subPaths beside the workspace', () => {
    const { accepted } = acceptCloudMounts([record({})])
    const pod = buildAgentPodManifest(kube, 'superagent-a', { agentId: 'a', envVars: {} }, {}, null, accepted)
    const container = (pod.spec?.containers as Array<{ volumeMounts: Array<{ name: string; mountPath: string; subPath: string }> }>)[0]
    expect(container.volumeMounts).toEqual([
      { name: 'workspaces', mountPath: '/workspace', subPath: 'agents/a/workspace' },
      { name: 'workspaces', mountPath: '/volumes/team-brain', subPath: 'volumes/v1' },
    ])
  })

  it('acceptCloudMounts keeps /volumes records on the disk and drops the rest', () => {
    const folder = record({ id: 'm1', hostPath: '/data/agents/other/workspace', containerPath: '/mounts/other', folderName: 'other' })
    const offDisk = record({ id: 'v2', hostPath: '/sqlite/x', containerPath: '/volumes/x', folderName: 'x' })
    const { accepted, dropped } = acceptCloudMounts([record({}), folder, offDisk])
    expect(accepted.map((m) => m.subPath)).toEqual(['volumes/v1'])
    expect(dropped).toEqual([folder, offDisk])
  })
})

describe('withRetry', () => {
  const noSleep = async () => {}

  it('retries a retryable status then succeeds', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw new KubeApiError('conflict', 409)
      return 'ok'
    })
    const result = await withRetry(fn, { attempts: 8, baseDelayMs: 1, maxDelayMs: 1, retryableStatuses: [409] }, noSleep)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry a non-retryable status', async () => {
    const fn = vi.fn(async () => { throw new KubeApiError('not found', 404) })
    await expect(
      withRetry(fn, { attempts: 4, baseDelayMs: 1, maxDelayMs: 1, retryableStatuses: [409, 500] }, noSleep),
    ).rejects.toThrow('not found')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries transport errors (statusCode 0) and gives up after attempts', async () => {
    const fn = vi.fn(async () => { throw new KubeApiError('socket hang up', 0) })
    await expect(
      withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, retryableStatuses: [] }, noSleep),
    ).rejects.toThrow('socket hang up')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry a plain (non-KubeApiError) error', async () => {
    const fn = vi.fn(async () => { throw new Error('bad json') })
    await expect(
      withRetry(fn, { attempts: 4, baseDelayMs: 1, maxDelayMs: 1, retryableStatuses: [500] }, noSleep),
    ).rejects.toThrow('bad json')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('kubeResourceName', () => {
  it('sanitizes agent ids and stays within DNS label limits', () => {
    const name = kubeResourceName('superagent', 'Agent With Spaces!!!')
    expect(name).toMatch(/^superagent-agent-with-spaces-[a-f0-9]{8}$/)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('is stable for the same agent id', () => {
    expect(kubeResourceName('superagent', 'same-id')).toBe(kubeResourceName('superagent', 'same-id'))
  })

  it('differs for different agent ids with the same sanitized prefix', () => {
    expect(kubeResourceName('superagent', 'agent-a')).not.toBe(kubeResourceName('superagent', 'agent-b'))
  })
})

describe('kubernetes quantity parsing', () => {
  it('parses cpu quantities', () => {
    expect(parseKubernetesCpuCores('250m')).toBe(0.25)
    expect(parseKubernetesCpuCores('2')).toBe(2)
  })

  it('parses memory quantities', () => {
    expect(parseKubernetesMemoryBytes('512Mi')).toBe(512 * 1024 ** 2)
    expect(parseKubernetesMemoryBytes('1Gi')).toBe(1024 ** 3)
  })
})

describe('resolveKubeConfigOrNull', () => {
  afterEach(() => {
    resetPlatformK8sRuntimeStateForTests()
    for (const key of KUBE_ENV_KEYS) delete process.env[key]
    mockCaptureException.mockClear()
  })

  it('returns null when required env is missing', () => {
    expect(resolveKubeConfigOrNull()).toBeNull()
  })

  it('parses deployment metadata env maps and drops invalid label values', () => {
    process.env.K8S_NAMESPACE = 'org-abc123'
    process.env.K8S_WORKSPACES_PVC = 'org-data'
    process.env.K8S_EXTRA_LABELS = JSON.stringify({
      'gamut.cloud/org-id': 'org_abc123',
      'bad.label': 'not valid!!!',
    })
    process.env.K8S_EXTRA_ANNOTATIONS = JSON.stringify({ 'gamut.cloud/deployment-id': 'staging-usw2' })

    expect(resolveKubeConfigOrNull()).toEqual({
      namespace: 'org-abc123',
      pvcName: 'org-data',
      imagePullSecretName: null,
      extraLabels: { 'gamut.cloud/org-id': 'org_abc123' },
      extraAnnotations: { 'gamut.cloud/deployment-id': 'staging-usw2' },
    })
    expect(mockCaptureException).toHaveBeenCalled()
  })

  it('returns empty maps for malformed JSON env', () => {
    process.env.K8S_NAMESPACE = 'org-abc123'
    process.env.K8S_WORKSPACES_PVC = 'org-data'
    process.env.K8S_EXTRA_LABELS = '{not-json'

    expect(resolveKubeConfigOrNull()?.extraLabels).toEqual({})
    expect(mockCaptureException).toHaveBeenCalled()
  })
})

describe('requestJsonOnce', () => {
  beforeEach(() => {
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (String(path).includes('token')) return 'test-token'
      if (String(path).includes('ca.crt')) return 'ca-cert'
      throw new Error(`ENOENT ${path}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.KUBERNETES_SERVICE_HOST
    delete process.env.KUBERNETES_SERVICE_PORT
  })

  it('returns parsed JSON on success', async () => {
    installHttpsMock(() => ({ statusCode: 200, body: '{"phase":"Running"}' }))
    await expect(requestJsonOnce('GET', '/api/v1/namespaces/default/pods/foo')).resolves.toEqual({ phase: 'Running' })
  })

  it('throws KubeApiError on unexpected status codes', async () => {
    installHttpsMock(() => ({ statusCode: 404, body: 'not found' }))
    await expect(requestJsonOnce('GET', '/api/v1/namespaces/default/pods/missing')).rejects.toMatchObject({
      name: 'KubeApiError',
      statusCode: 404,
    })
  })

  it('throws when service account credentials are unavailable', async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('missing token') })
    await expect(requestJsonOnce('GET', '/api/v1/namespaces/default/pods/foo')).rejects.toThrow(
      'Kubernetes service account token and KUBERNETES_SERVICE_HOST are required',
    )
  })
})

describe('PlatformK8sRuntimeClient operability', () => {
  beforeEach(() => {
    resetPlatformK8sRuntimeStateForTests()
    process.env.K8S_NAMESPACE = 'org-abc123'
    process.env.K8S_WORKSPACES_PVC = 'org-data'
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    process.env.HOST_PUBLIC_URL = 'https://org.example.com'
    mockStorageSubPath.mockImplementation((p) => p.startsWith('/data/') ? p.slice('/data/'.length) : null)
    mockGetSettings.mockReturnValue({
      container: { agentImage: 'img', resourceLimits: { cpu: 1, memory: '1g' } },
      enableToolSearch: true,
    })
    vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
      if (String(path).includes('token')) return 'test-token'
      if (String(path).includes('ca.crt')) return 'ca-cert'
      throw new Error(`ENOENT ${path}`)
    })
  })

  afterEach(() => {
    resetPlatformK8sRuntimeStateForTests()
    vi.restoreAllMocks()
    for (const key of KUBE_ENV_KEYS) delete process.env[key]
    mockCaptureException.mockClear()
  })

  it('returns the ready pod state from start()', async () => {
    installHttpsMock(() => ({
      statusCode: 200,
      body: JSON.stringify({
        status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true }] },
      }),
    }))
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })

    await expect(client.start()).resolves.toEqual({ status: 'running', port: 3000 })
  })

  it('start() reports dropped records and creates the pod with only the accepted mounts and SUPERAGENT_MOUNTS', async () => {
    mockGetSettings.mockReturnValue({ container: { agentImage: 'img', resourceLimits: { cpu: 1, memory: '1g' } }, enableToolSearch: true })
    const posted: Array<{ path: string; body: unknown }> = []
    let podCreated = false
    installHttpsMock((method, path, body) => {
      if (method === 'POST') { posted.push({ path, body: JSON.parse(body) }); if (path.endsWith('/pods')) podCreated = true; return { statusCode: 201, body: '{}' } }
      if (method === 'DELETE') return { statusCode: 404, body: '{}' }
      if (path.includes('/pods/')) {
        return podCreated
          ? { statusCode: 200, body: JSON.stringify({ status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true }] } }) }
          : { statusCode: 404, body: '{}' }
      }
      return { statusCode: 404, body: '{}' }
    })
    vi.spyOn(PlatformK8sRuntimeClient.prototype as unknown as { waitForHealthy: () => Promise<boolean> }, 'waitForHealthy').mockResolvedValue(true)
    const dropped: AgentMount[] = []
    const folder = record({ id: 'm1', hostPath: '/data/agents/other/workspace', containerPath: '/mounts/other', folderName: 'other' })
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await client.start({ mounts: [record({}), folder], onMountDropped: (m) => dropped.push(m) })
    expect(dropped).toEqual([folder])
    const pod = posted.find((p) => p.path.endsWith('/pods'))!.body as { spec: { containers: Array<{ volumeMounts: Array<{ mountPath: string }>; env: Array<{ name: string; value: string }> }> } }
    expect(pod.spec.containers[0].volumeMounts.map((v) => v.mountPath)).toEqual(['/workspace', '/volumes/team-brain'])
    expect(pod.spec.containers[0].env).toContainEqual({ name: 'SUPERAGENT_MOUNTS', value: JSON.stringify(['/volumes/team-brain']) })
  })

  it('fetches pod logs via the Kubernetes log API', async () => {
    installHttpsMock((_method, path) => {
      expect(path).toContain('/log?container=agent&tailLines=20')
      return { statusCode: 200, body: 'agent started\nlistening on 3000' }
    })
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await expect(client.getLogs(20)).resolves.toBe('agent started\nlistening on 3000')
  })

  it('returns stats from metrics-server when available', async () => {
    installHttpsMock((_method, path) => {
      if (path.includes('metrics.k8s.io')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            containers: [{ name: 'agent', usage: { cpu: '500m', memory: '256Mi' } }],
          }),
        }
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          spec: { containers: [{ name: 'agent', resources: { limits: { cpu: '2', memory: '512Mi' } } }] },
          status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true }] },
        }),
      }
    })

    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await expect(client.getStats()).resolves.toEqual({
      memoryUsageBytes: 256 * 1024 ** 2,
      memoryLimitBytes: 512 * 1024 ** 2,
      memoryPercent: 50,
      cpuPercent: 25,
    })
  })

  it('returns null stats when metrics-server is unavailable', async () => {
    installHttpsMock((_method, path) => ({
      statusCode: path.includes('metrics.k8s.io') ? 404 : 200,
      body: path.includes('metrics.k8s.io')
        ? 'not found'
        : JSON.stringify({
          spec: { containers: [{ name: 'agent', resources: { limits: { cpu: '2', memory: '512Mi' } } }] },
          status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true }] },
        }),
    }))
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await expect(client.getStats()).resolves.toBeNull()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('does not capture Sentry events for missing pods in getInfoFromRuntime', async () => {
    installHttpsMock(() => ({ statusCode: 404, body: 'not found' }))
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await expect(client.getInfoFromRuntime()).resolves.toEqual({ status: 'stopped', port: null })
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('treats a Terminating pod (deletionTimestamp set) as stopped', async () => {
    installHttpsMock(() => ({
      statusCode: 200,
      body: JSON.stringify({
        metadata: { deletionTimestamp: '2026-06-16T21:00:00Z' },
        status: { phase: 'Running', containerStatuses: [{ name: 'agent', ready: true }] },
      }),
    }))
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await expect(client.getInfoFromRuntime()).resolves.toEqual({ status: 'stopped', port: null })
  })

  it('isAvailable is false without HOST_PUBLIC_URL and true with it', async () => {
    delete process.env.HOST_PUBLIC_URL
    await expect(PlatformK8sRuntimeClient.isAvailable()).resolves.toBe(false)
    process.env.HOST_PUBLIC_URL = 'https://org.example.com'
    await expect(PlatformK8sRuntimeClient.isAvailable()).resolves.toBe(true)
  })

  it('stop waits until the pod is actually gone before resolving', async () => {
    let podCallCount = 0
    installHttpsMock((_method, path) => {
      if (path.includes('/services/')) return { statusCode: 200, body: '{}' }
      // pod path: DELETE accepted, then GET polls present-once before 404.
      podCallCount++
      if (podCallCount === 1) return { statusCode: 202, body: '{}' }
      if (podCallCount === 2) return { statusCode: 200, body: JSON.stringify({ status: { phase: 'Running' } }) }
      return { statusCode: 404, body: 'not found' }
    })
    const client = new PlatformK8sRuntimeClient({ agentId: 'agent-a', envVars: {} })
    await expect(client.stop()).resolves.toEqual({ forceStopUsed: false, stopped: true })
    expect(podCallCount).toBeGreaterThanOrEqual(3)
  })
})
