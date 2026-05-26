import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import type { ChildProcess } from 'child_process'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT, execWithPath, spawnWithPath } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, StartOptions, StopOptions } from './types'
import { getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'

const LOCAL_PORT_START = 13000

interface KubeConfig {
  namespace: string
  pvcName: string
  orgSlug: string
}

export class KubernetesContainerClient extends BaseContainerClient {
  static readonly runnerName = 'kubernetes'
  private portForward: ChildProcess | null = null
  private forwardedPort: number | null = null

  constructor(config: ContainerConfig) {
    super(config)
  }

  protected getRunnerCommand(): string {
    return 'kubectl'
  }

  static isEligible(): boolean {
    return true
  }

  static async isAvailable(): Promise<boolean> {
    try {
      await execWithPath('kubectl version --client')
      return true
    } catch {
      return false
    }
  }

  static async isRunning(): Promise<boolean> {
    try {
      await execWithPath('kubectl version --client')
      await execWithPath('kubectl cluster-info')
      return true
    } catch {
      return false
    }
  }

  async start(options?: StartOptions): Promise<void> {
    const info = await this.getInfoFromRuntime()
    if (info.status === 'running') {
      const port = info.port ?? await this.findLocalPort()
      await this.ensurePortForward(port)
      return
    }

    const kube = getKubeConfig()
    await execWithPath(`kubectl -n ${kube.namespace} delete pod/${this.podName()} service/${this.serviceName()} --ignore-not-found=true`)
    const manifestPath = this.writeManifest(kube, options?.envVars ?? {})
    try {
      await execWithPath(`kubectl apply -f "${manifestPath}"`)
    } finally {
      fs.unlinkSync(manifestPath)
    }

    await execWithPath(`kubectl -n ${kube.namespace} wait --for=condition=Ready pod/${this.podName()} --timeout=300s`)
    const port = await this.findLocalPort()
    await this.ensurePortForward(port)

    if (!(await this.waitForHealthy(60_000, port))) {
      this.stopPortForward()
      throw new Error(`Kubernetes agent pod ${this.podName()} failed to become healthy`)
    }
  }

  async stop(_options?: StopOptions): Promise<{ forceStopUsed: boolean }> {
    this.stopPortForward()
    const { namespace } = getKubeConfig()
    await execWithPath(`kubectl -n ${namespace} delete pod/${this.podName()} service/${this.serviceName()} --ignore-not-found=true`)
    return { forceStopUsed: false }
  }

  stopSync(): void {
    this.stopPortForward()
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const { namespace } = getKubeConfig()
    try {
      const { stdout } = await execWithPath(
        `kubectl -n ${namespace} get pod ${this.podName()} -o jsonpath='{.status.phase} {.status.containerStatuses[0].ready}'`
      )
      const [phase, ready] = stdout.trim().replace(/'/g, '').split(/\s+/)
      if (phase === 'Running' && ready === 'true') {
        return { status: 'running', port: this.forwardedPort }
      }
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

  private writeManifest(kube: KubeConfig, envVars: Record<string, string>): string {
    const settings = getSettings()
    const image = process.env.K8S_AGENT_IMAGE || settings.container.agentImage
    const mergedEnvVars: Record<string, string | undefined> = {
      ...getActiveLlmProvider().getContainerEnvVars(),
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      ENABLE_TOOL_SEARCH: settings.enableToolSearch !== false ? 'true' : 'false',
      ...this.config.envVars,
      ...envVars,
    }
    const env = Object.entries(mergedEnvVars)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => ({ name, value }))
    const manifest = {
      apiVersion: 'v1',
      kind: 'List',
      items: [
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: this.serviceName(), namespace: kube.namespace },
          spec: {
            selector: { app: this.podName() },
            ports: [{ name: 'http', port: CONTAINER_INTERNAL_PORT, targetPort: CONTAINER_INTERNAL_PORT }],
          },
        },
        {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: this.podName(),
            namespace: kube.namespace,
            labels: {
              app: this.podName(),
              'superagent.ai/runtime': 'kubernetes',
              'superagent.ai/agent': this.config.agentId,
              'superagent.ai/org': kube.orgSlug,
            },
          },
          spec: {
            restartPolicy: 'Never',
            containers: [{
              name: 'agent',
              image,
              env,
              ports: [{ containerPort: CONTAINER_INTERNAL_PORT }],
              volumeMounts: [{
                name: 'workspaces',
                mountPath: '/workspace',
                subPath: `${kube.orgSlug}/${this.config.agentId}`,
              }],
            }],
            volumes: [{
              name: 'workspaces',
              persistentVolumeClaim: { claimName: kube.pvcName },
            }],
          },
        },
      ],
    }
    const filePath = path.join(os.tmpdir(), `superagent-k8s-${this.config.agentId}-${Date.now()}.json`)
    fs.writeFileSync(filePath, JSON.stringify(manifest))
    return filePath
  }

  private async ensurePortForward(port: number): Promise<void> {
    if (this.portForward && this.forwardedPort === port && !this.portForward.killed) return
    this.stopPortForward()
    const { namespace } = getKubeConfig()
    this.portForward = spawnWithPath('kubectl', [
      '-n', namespace,
      'port-forward',
      `service/${this.serviceName()}`,
      `${port}:${CONTAINER_INTERNAL_PORT}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.forwardedPort = port
    await waitForPortForward(this.portForward)
  }

  private stopPortForward(): void {
    if (this.portForward && !this.portForward.killed) {
      this.portForward.kill()
    }
    this.portForward = null
    this.forwardedPort = null
  }

  private async findLocalPort(): Promise<number> {
    for (let port = LOCAL_PORT_START; port < LOCAL_PORT_START + 1000; port++) {
      if (await isPortAvailable(port)) return port
    }
    throw new Error('No local port available for kubectl port-forward')
  }

  private podName(): string {
    return `superagent-${sanitizeKubeName(this.config.agentId)}`
  }

  private serviceName(): string {
    return this.podName()
  }
}

function getKubeConfig(): KubeConfig {
  const namespace = process.env.K8S_NAMESPACE
  const pvcName = process.env.K8S_WORKSPACES_PVC
  const orgSlug = process.env.K8S_ORG_SLUG || 'org-a'
  if (!namespace || !pvcName) {
    throw new Error('K8S_NAMESPACE and K8S_WORKSPACES_PVC are required for REMOTE_RUNTIME=kubernetes')
  }
  return { namespace, pvcName, orgSlug }
}

function sanitizeKubeName(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return sanitized || 'agent'
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

function waitForPortForward(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for kubectl port-forward')), 15_000)
    const onData = (data: Buffer) => {
      const text = data.toString()
      if (text.includes('Forwarding from')) {
        clearTimeout(timeout)
        resolve()
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (text.includes('error') || text.includes('unable')) {
        clearTimeout(timeout)
        reject(new Error(`kubectl port-forward failed: ${text.trim()}`))
      }
    })
    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`kubectl port-forward exited with code ${code}`))
    })
  })
}
