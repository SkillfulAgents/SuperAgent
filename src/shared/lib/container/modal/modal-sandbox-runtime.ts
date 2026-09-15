/**
 * An agent's container as a Modal sandbox: the agent image from the registry,
 * the agent's Modal volume mounted at `/workspace`, and the container API
 * reached over the sandbox's TLS tunnel.
 *
 * Everything HTTP — sessions, messages, the stream, health — is the base
 * client's, pointed at the tunnel URL instead of a local port. What this
 * class adds is the lifecycle: create the sandbox, find it again by name
 * after this process restarts, and terminate it. Stop means terminate, as it
 * does for every other remote runtime; the workspace outlives the sandbox on
 * the volume.
 *
 * The sandbox reaches this host through `HOST_PUBLIC_URL`, the same contract
 * the Kubernetes and MicroVM runtimes use.
 */
import { NotFoundError, type Sandbox } from 'modal'
import { BaseContainerClient, CONTAINER_INTERNAL_PORT, parseMemoryValue } from '../base-container-client'
import type { ContainerInfo, ContainerStats, StartOptions, StopOptions, StopResult } from '../types'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { modalVolumeNameFor, readAgentPlacement } from '@shared/lib/agent-actor/placement'
import { getModalApp, getModalClient, isModalConfigured, modalAppName } from './modal-client'
import { forgetSandbox, getSandbox, setSandbox, type SandboxState } from './modal-sandboxes'
import { ModalVolumeFiles } from './modal-volume'

/** Modal's ceiling for a sandbox's lifetime. A longer-lived agent is a new sandbox on the same volume. */
const SANDBOX_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000
/**
 * Safety net for a host that dies without stopping its sandboxes: with no
 * exec, stdin or tunnel connection for this long, Modal terminates the
 * sandbox. The host's own auto-sleep normally stops it far sooner.
 */
const SANDBOX_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000
const HEALTHY_TIMEOUT_MS = 180_000
const AGENT_TAG = 'superagent-agent'
/** `USER claude` (uid/gid 1000) in agent-container/Dockerfile, the same constant the k8s runtime pins. */
const AGENT_UID = 1000

/**
 * The sandbox's main process: own the workspace, then run the agent server
 * as the agent user. `exec` keeps the server as the process Modal watches.
 */
export function startCommand(): string {
  return [
    `chown ${AGENT_UID}:${AGENT_UID} /workspace`,
    'chmod 777 /workspace',
    `exec setpriv --reuid=${AGENT_UID} --regid=${AGENT_UID} --init-groups node dist/server.js`,
  ].join(' && ')
}

/** What the sandbox printed, for the error a failed start throws. Best effort, bounded. */
async function startupOutput(sandbox: Sandbox): Promise<string> {
  const read = async (stream: { readText(): Promise<string> }, label: string) => {
    const text = await Promise.race([
      stream.readText().catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 5_000)),
    ])
    return text.trim() ? `\n\n${label}:\n${text.trim().slice(-2000)}` : ''
  }
  return (await read(sandbox.stderr, 'Sandbox stderr')) + (await read(sandbox.stdout, 'Sandbox stdout'))
}

/** The sandbox name for an agent: the id, in the character set Modal accepts. */
export function sandboxNameFor(slug: string): string {
  const safe = slug.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'agent'
  return `superagent-${safe}`.slice(0, 63)
}

export class ModalSandboxRuntimeClient extends BaseContainerClient {
  static readonly runnerName = 'modal'
  // The image is pulled by Modal from the registry; nothing is needed on this machine.
  static readonly requiresLocalImage = false

  static isEligible(): boolean {
    return isModalConfigured()
  }

  static async isAvailable(): Promise<boolean> {
    return isModalConfigured() && Boolean(process.env.HOST_PUBLIC_URL?.trim())
  }

  static async isRunning(): Promise<boolean> {
    return this.isAvailable()
  }

  protected getRunnerCommand(): string {
    return 'modal'
  }

  private get slug(): string {
    return this.config.agentId
  }

  async start(options?: StartOptions): Promise<ContainerInfo> {
    const info = await this.getInfoFromRuntime()
    if (info.status === 'running') {
      this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
      return info
    }

    const modal = getModalClient()
    const app = await getModalApp()
    const placement = readAgentPlacement(this.slug)
    const volumeName = placement.runtime === 'modal' ? placement.volumeName : modalVolumeNameFor(this.slug)
    // Created as a version-2 volume here, so the mount below never creates a version-1 one.
    await ModalVolumeFiles.ensure(volumeName)
    const volume = await modal.volumes.fromName(volumeName)

    const settings = getSettings()
    // Modal pulls from a registry, so a locally built image tag cannot be it;
    // `MODAL_AGENT_IMAGE` names the registry image when the setting is one.
    const image = modal.images.fromRegistry(process.env.MODAL_AGENT_IMAGE?.trim() || settings.container.agentImage)
    const memoryBytes = parseMemoryValue(settings.container.resourceLimits.memory)
    const cpu = settings.container.resourceLimits.cpu

    const sandbox = await modal.sandboxes.create(app, image, {
      name: sandboxNameFor(this.slug),
      tags: { [AGENT_TAG]: this.slug },
      // The image's own entrypoint, as the image's own user: Modal starts
      // every sandbox as root and ignores the image's USER, and the Claude
      // CLI refuses to run with its permission prompts skipped as root. The
      // volume mounts as root's, read-only to anyone else, so the root
      // moment is spent handing the workspace to the agent user first.
      command: ['sh', '-c', startCommand()],
      workdir: '/app',
      env: this.buildAgentEnv(options?.envVars),
      volumes: { '/workspace': volume },
      encryptedPorts: [CONTAINER_INTERNAL_PORT],
      timeoutMs: SANDBOX_MAX_LIFETIME_MS,
      idleTimeoutMs: SANDBOX_IDLE_TIMEOUT_MS,
      ...(cpu > 0 ? { cpu } : {}),
      ...(memoryBytes > 0 ? { memoryMiB: Math.round(memoryBytes / (1024 * 1024)) } : {}),
    })

    try {
      const tunnel = (await sandbox.tunnels())[CONTAINER_INTERNAL_PORT]
      if (!tunnel) throw new Error(`Modal sandbox ${sandbox.sandboxId} exposed no tunnel for port ${CONTAINER_INTERNAL_PORT}`)
      setSandbox(this.slug, { sandbox, baseUrl: tunnel.url })
      this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
      if (!(await this.waitForHealthy(HEALTHY_TIMEOUT_MS, CONTAINER_INTERNAL_PORT))) {
        const exited = (await sandbox.poll().catch(() => null)) !== null
        throw new Error(
          `Modal sandbox ${sandbox.sandboxId} for agent ${this.slug} ${exited ? 'exited before it became healthy' : `did not become healthy within ${HEALTHY_TIMEOUT_MS / 1000}s`}${await startupOutput(sandbox)}`,
        )
      }
    } catch (error) {
      await this.teardown(sandbox)
      throw error
    }

    return { status: 'running', port: CONTAINER_INTERNAL_PORT }
  }

  async stop(_options?: StopOptions): Promise<StopResult> {
    this.terminateWebSocketConnections()
    const state = getSandbox(this.slug) ?? (await this.adopt())
    if (state) await this.teardown(state.sandbox)
    return { forceStopUsed: false, stopped: true }
  }

  stopSync(): void {
    // Termination is an async RPC; a sync shutdown can only drop the streams.
    // The sandbox is reclaimed by the next stop or by its idle timeout.
    this.terminateWebSocketConnections()
  }

  private async teardown(sandbox: Sandbox): Promise<void> {
    forgetSandbox(this.slug, sandbox)
    this.rememberRunningPort(null)
    try {
      await sandbox.terminate()
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
    }
  }

  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const state = getSandbox(this.slug)
    if (state) {
      try {
        const exitCode = await state.sandbox.poll()
        if (exitCode === null) return { status: 'running', port: CONTAINER_INTERNAL_PORT }
        forgetSandbox(this.slug, state.sandbox)
        this.rememberRunningPort(null)
        return { status: 'stopped', port: null }
      } catch (error) {
        captureException(error, {
          tags: { area: 'container', op: 'modal.poll' },
          extra: { agentId: this.slug, sandboxId: state.sandbox.sandboxId },
        })
        // Transient control-plane trouble: keep the last known state rather
        // than orphan a live sandbox. The runtime's health probe backstops it.
        return { status: 'running', port: CONTAINER_INTERNAL_PORT }
      }
    }
    return (await this.adopt()) ? { status: 'running', port: CONTAINER_INTERNAL_PORT } : { status: 'stopped', port: null }
  }

  /** Find this agent's running sandbox by name (after this process restarted) and remember its tunnel. */
  private async adopt(): Promise<SandboxState | null> {
    if (!isModalConfigured()) return null
    try {
      const sandbox = await getModalClient().sandboxes.fromName(modalAppName(), sandboxNameFor(this.slug))
      const tunnel = (await sandbox.tunnels())[CONTAINER_INTERNAL_PORT]
      if (!tunnel) return null
      const state: SandboxState = { sandbox, baseUrl: tunnel.url }
      setSandbox(this.slug, state)
      this.rememberRunningPort(CONTAINER_INTERNAL_PORT)
      return state
    } catch (error) {
      if (error instanceof NotFoundError) return null
      captureException(error, { tags: { area: 'container', op: 'modal.adopt' }, extra: { agentId: this.slug } })
      return null
    }
  }

  async getStats(): Promise<ContainerStats | null> {
    // Modal exposes no per-sandbox resource metrics through the SDK.
    return null
  }

  public buildVolumeFlag(_hostPath: string, _containerPath: string): string {
    // The workspace is the volume; host folders cannot be mounted into a sandbox.
    return ''
  }

  protected getBaseUrl(_port: number): string {
    const state = getSandbox(this.slug)
    if (!state) throw new Error(`Modal sandbox for agent ${this.slug} is not running`)
    return state.baseUrl
  }

  public getWebSocketBaseUrl(port: number): string {
    return this.getBaseUrl(port).replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  }

  public getHostApiBaseUrl(): string {
    const publicUrl = process.env.HOST_PUBLIC_URL?.trim().replace(/\/+$/, '')
    if (!publicUrl) {
      throw new Error('HOST_PUBLIC_URL is required for the Modal runtime: the sandbox reaches this host through it')
    }
    return publicUrl
  }
}
