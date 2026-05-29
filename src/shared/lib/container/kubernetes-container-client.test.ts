import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ContainerConfig } from './types'

const mockGetSettings = vi.fn()
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}))

vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({
    getContainerEnvVars: () => ({ ANTHROPIC_API_KEY: 'test-key' }),
  }),
}))

import {
  buildAgentPodManifest,
  buildAgentServiceManifest,
  type KubeConfig,
} from './kubernetes-container-client'

const kube: KubeConfig = {
  namespace: 'org-abc123',
  pvcName: 'org-data',
  orgSlug: 'org-abc123',
  orgId: 'org_abc123',
  runtimeVersion: 'v1.2.3',
  workspaceSubPathPrefix: 'staging-usw2/org-abc123/workspaces',
  imagePullSecretName: 'ghcr-pull-secret',
}

describe('KubernetesContainerClient manifests', () => {
  beforeEach(() => {
    mockGetSettings.mockReturnValue({
      container: { agentImage: 'settings-agent-image' },
      enableToolSearch: true,
    })
    process.env.K8S_AGENT_IMAGE = 'k8s-agent-image'
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.K8S_AGENT_IMAGE
  })

  it('builds agent pod manifest with cloud labels and workspace subPath', () => {
    const config: ContainerConfig = {
      agentId: 'Agent With Spaces',
      envVars: { EXTRA_ENV: 'extra' },
    }

    const pod = buildAgentPodManifest(kube, 'superagent-agent-with-spaces-12345678', config, { RUNTIME_ENV: 'runtime' })

    expect(pod.metadata.labels).toMatchObject({
      app: 'superagent-agent-with-spaces-12345678',
      'gamut.cloud/component': 'agent-container',
      'gamut.cloud/org-id': 'org_abc123',
      'gamut.cloud/runtime-version': 'v1.2.3',
      'superagent.ai/runtime': 'kubernetes',
    })
    expect(pod.metadata.annotations).toEqual({ 'superagent.ai/agent-id': 'Agent With Spaces' })
    expect(pod.spec?.automountServiceAccountToken).toBe(false)
    expect(pod.spec?.imagePullSecrets).toEqual([{ name: 'ghcr-pull-secret' }])

    const container = (pod.spec?.containers as Array<any>)[0]
    expect(container.image).toBe('k8s-agent-image')
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'ANTHROPIC_API_KEY', value: 'test-key' },
      { name: 'EXTRA_ENV', value: 'extra' },
      { name: 'RUNTIME_ENV', value: 'runtime' },
      { name: 'CLAUDE_CONFIG_DIR', value: '/workspace/.claude' },
    ]))
    expect(container.volumeMounts[0]).toMatchObject({
      mountPath: '/workspace',
      subPath: 'staging-usw2/org-abc123/workspaces/Agent-With-Spaces',
    })
  })

  it('builds service manifest selecting the agent pod labels', () => {
    const service = buildAgentServiceManifest(kube, 'superagent-a', 'superagent-a')

    expect(service.spec?.selector).toEqual({
      app: 'superagent-a',
      'gamut.cloud/component': 'agent-container',
    })
    expect(service.spec?.ports).toEqual([{ name: 'http', port: 3000, targetPort: 3000 }])
  })
})
