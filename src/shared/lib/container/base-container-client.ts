import { exec, execSync, spawn } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import * as fs from 'fs'
import os from 'os'
import net from 'net'
import type {
  ContainerClient,
  ContainerConfig,
  ContainerInfo,
  ContainerSession,
  ContainerStats,
  CreateSessionOptions,
  StartOptions,
  StopOptions,
  StopResult,
  StreamMessage,
} from './types'
import type { RuntimeOptions } from './runtime-options'
import { getAgentWorkspaceDir } from '@shared/lib/config/data-dir'
import { getContainerHostUrl, getAppPort } from '@shared/lib/proxy/host-url'
import { getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { resolveContainerModel, getContainerModelPromptHints } from './resolve-model'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'

const execAsync = promisify(exec)

/**
 * Common paths where Docker/Podman might be installed.
 * Packaged apps don't inherit the user's shell PATH.
 */
const COMMON_BINARY_PATHS: Record<string, string[]> = {
  darwin: [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/opt/podman/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
  ],
  linux: [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/podman/bin',
  ],
  win32: [
    'C:\\Program Files\\Docker\\Docker\\resources\\bin',
    'C:\\ProgramData\\DockerDesktop\\version-bin',
  ],
}

/**
 * Get the PATH environment variable with common binary locations added.
 */
export function getEnhancedPath(): string {
  const currentPath = process.env.PATH || ''
  const platformPaths = COMMON_BINARY_PATHS[process.platform] || []
  const pathsToAdd = platformPaths.filter(p => !currentPath.includes(p))
  return [...pathsToAdd, currentPath].join(path.delimiter)
}

const isWindows = process.platform === 'win32'

/**
 * Wrap a value in the platform-appropriate shell quotes.
 * On Unix, single quotes; on Windows cmd.exe, double quotes.
 *
 * NOTE: this is a naive wrapper — it does NOT escape quote characters embedded
 * in `value`. It is safe only for known-literal arguments (e.g. Go template
 * format strings like `{{json .}}`). For user-controlled values that are
 * interpolated into a command string and run through a real shell, use
 * shellEscape() instead.
 */
export function shellQuote(value: string): string {
  return isWindows ? `"${value}"` : `'${value}'`
}

/**
 * Shell-escape a user-controlled value so it survives interpolation into a
 * command string executed by a real shell (child_process.exec → /bin/sh -c on
 * Unix). Unlike shellQuote(), this escapes embedded quote characters so the
 * value can never break out of its quoted region and re-enable expansion.
 *
 * On Unix: wrap in single quotes and rewrite each embedded `'` as `'\''`
 * (close-quote, escaped-quote, reopen-quote). Inside single quotes nothing —
 * not `$(...)`, backticks, nor `$VAR` — is special, so the value is inert.
 * On Windows cmd.exe: wrap in double quotes and escape embedded `"` (a path
 * cannot legally contain `"`, so this is belt-and-suspenders).
 */
export function shellEscape(value: string): string {
  if (isWindows) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Execute a command with enhanced PATH (includes common binary locations).
 *
 * On failure, enriches the error message with stderr/stdout so Sentry captures
 * the actual failure reason rather than just "Command failed: <command>". The
 * original `.stderr`/`.stdout`/`.code` properties are preserved for callers
 * that inspect them directly.
 */
export async function execWithPath(
  command: string,
  opts?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execAsync(command, {
      env: { ...process.env, PATH: getEnhancedPath() },
      // When set, exec kills the child with SIGKILL after timeoutMs so a hung
      // command (e.g. a guest liveness probe against a wedged VM) can't dangle.
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    })
  } catch (err) {
    // WSL emits UTF-16LE with embedded nulls; strip them so the message is readable.
    const stripNulls = (s: unknown) => String(s ?? '').replace(/\0/g, '').trim()
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    const stderr = stripNulls(e.stderr)
    const stdout = stripNulls(e.stdout)
    const parts = [e.message]
    if (stderr) parts.push(`stderr: ${stderr}`)
    if (stdout) parts.push(`stdout: ${stdout}`)
    e.message = parts.join('\n')
    throw e
  }
}

/**
 * Execute a command with enhanced PATH, ignoring any errors.
 * Replacement for the Unix shell idiom `cmd 2>/dev/null || true`.
 */
async function execWithPathSilent(command: string): Promise<void> {
  try {
    await execWithPath(command)
  } catch {
    // Intentionally ignored — container may not exist
  }
}

/**
 * Execute a command synchronously with enhanced PATH.
 */
export function execSyncWithPath(command: string, options?: { stdio?: 'pipe' | 'inherit'; timeout?: number }): Buffer {
  return execSync(command, {
    ...options,
    env: { ...process.env, PATH: getEnhancedPath() },
  })
}

/**
 * Spawn a process with enhanced PATH.
 */
export function spawnWithPath(command: string, args: string[], options?: { cwd?: string; stdio?: any }): ReturnType<typeof spawn> {
  return spawn(command, args, {
    ...options,
    env: { ...process.env, PATH: getEnhancedPath() },
    // On Windows, shell: true is needed to spawn .cmd/.bat wrapper scripts
    ...(isWindows && { shell: true }),
  })
}

/**
 * Check if a command is available on the system.
 */
export async function checkCommandAvailable(command: string): Promise<boolean> {
  try {
    await execWithPath(`${command} --version`)
    return true
  } catch {
    return false
  }
}

/**
 * Write environment variables to a Docker-compatible env file.
 * Returns the --env-file flag string and a cleanup function to delete the temp file.
 * Docker env-file format: one KEY=VALUE per line, no shell quoting needed.
 */
export function writeEnvFile(
  envVars: Record<string, string | undefined>,
  agentId: string,
  tmpDir?: string
): { flag: string; filePath: string; cleanup: () => void } {
  const content = Object.entries(envVars)
    .filter(([_, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value!.replace(/[\r\n]/g, '')}`)
    .join('\n')

  const dir = tmpDir || os.tmpdir()
  fs.mkdirSync(dir, { recursive: true })
  const envFilePath = path.join(dir, `superagent-env-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.writeFileSync(envFilePath, content, { mode: 0o600 })

  return {
    flag: `--env-file "${envFilePath}"`,
    filePath: envFilePath,
    cleanup: () => { try { fs.unlinkSync(envFilePath) } catch { /* ignore */ } },
  }
}

/**
 * Check if an error is a connection error (container not reachable).
 */
export function isConnectionError(err: Error): boolean {
  return (
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('ECONNRESET') ||
    err.message.includes('ETIMEDOUT') ||
    err.message.includes('fetch failed')
  )
}

export const AGENT_CONTAINER_PATH = './agent-container'
export const CONTAINER_INTERNAL_PORT = 3000
const BASE_PORT = 4000
// Max time for a single /health probe (isHealthy). Kept short because it gates
// the request hot path via ensureRunning's stale-cache liveness check.
const HEALTH_PROBE_TIMEOUT_MS = 2000

/**
 * Error thrown by ensureImageExists() when an image build fails, carrying the
 * captured stderr tail and exit code so start()'s catch can surface them to Sentry.
 */
interface ImageBuildError extends Error {
  imageBuildStderr?: string
  imageBuildExitCode?: number | null
}

/**
 * Parse a memory value string (e.g., "231.2MiB", "1.5GiB", "512MB") to bytes.
 */
export function parseMemoryValue(value: string): number {
  const match = value.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB|kB)?$/i)
  if (!match) return 0
  const num = parseFloat(match[1])
  const unit = (match[2] || 'B').toLowerCase()
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000, kib: 1024,
    mb: 1e6, mib: 1024 ** 2,
    gb: 1e9, gib: 1024 ** 3,
    tb: 1e12, tib: 1024 ** 4,
  }
  return Math.round(num * (multipliers[unit] || 1))
}

/**
 * Base class for OCI-compatible container runtimes (Docker, Podman, etc.)
 * Subclasses should override getRunnerCommand() to specify the CLI command,
 * and the static methods isAvailable() and isRunning().
 */
export abstract class BaseContainerClient extends EventEmitter implements ContainerClient {
  protected config: ContainerConfig
  private wsConnections: Map<string, WebSocket> = new Map()

  /** Whether this runner is eligible on the current platform. Override for platform-specific runners. */
  static isEligible(): boolean {
    return true
  }

  static readonly requiresLocalImage: boolean = true

  /** Whether the CLI is installed. Subclasses must override. */
  static async isAvailable(): Promise<boolean> {
    throw new Error('Subclass must implement static isAvailable()')
  }

  /** Whether the runtime daemon/service is running. Subclasses must override. */
  static async isRunning(): Promise<boolean> {
    throw new Error('Subclass must implement static isRunning()')
  }

  constructor(config: ContainerConfig) {
    super()
    this.config = config
  }

  /**
   * Emit an 'error' event without crashing the process.
   *
   * Node's EventEmitter throws synchronously when 'error' is emitted and no
   * 'error' listener is registered. Most consumers of this client never attach
   * one, so a bare `this.emit('error', ...)` would throw — and when that emit
   * happens inside a free-floating promise chain (e.g. the WebSocket
   * `setupWebSocket().catch()` path), the throw escapes as an unhandled
   * rejection. Guard every error emit through here so a missing listener is a
   * no-op instead of a crash.
   */
  protected safeEmitError(error: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    }
  }

  /**
   * Check if an error is a connection error (container not reachable).
   */
  private isConnectionError(err: Error): boolean {
    return isConnectionError(err)
  }

  /**
   * Handle a connection error - notify via callback if configured.
   */
  protected handleConnectionError(): void {
    if (this.config.onConnectionError) {
      this.config.onConnectionError()
    }
  }

  /**
   * Returns the CLI command for this container runtime (e.g., 'docker', 'podman').
   * May be a bare binary name or a full path. Use getRunnerShellCommand() when
   * interpolating into shell command strings.
   */
  protected abstract getRunnerCommand(): string

  /**
   * Returns the runner command quoted for safe interpolation into shell strings.
   * Paths under the user's home directory may contain spaces (e.g. "C:\Users\John Doe\...").
   */
  protected getRunnerShellCommand(): string {
    const cmd = this.getRunnerCommand()
    return cmd.includes(' ') ? shellQuote(cmd) : cmd
  }

  /**
   * Returns any additional flags needed for the run command.
   * Subclasses can override this to add runtime-specific flags.
   */
  protected getAdditionalRunFlags(): string {
    return ''
  }

  /**
   * Host-internal bridge IP a host-side service must bind to so this runner's
   * containers can reach it via host.docker.internal, or null when containers
   * reach the host's loopback directly. Default null — Docker Desktop and other
   * loopback-forwarding runtimes need no bridge bind. Runners that route
   * containers through a real gateway interface (Lima, WSL2, native Docker
   * bridge) override this so a host CDP proxy can bind that single interface
   * instead of 0.0.0.0 (SUP-217).
   */
  getHostBridgeIp(): string | null {
    return null
  }

  /**
   * Returns a suffix to append to volume mount specifications (e.g., ':U' for Podman).
   * Subclasses can override this for runtime-specific volume options.
   */
  protected getVolumeMountSuffix(): string {
    return ''
  }

  /**
   * Translate a host path for use inside the container runtime.
   * Default implementation forward-slashes the path. Subclasses can override
   * for runtimes where host paths map differently (e.g., WSL2).
   */
  protected hostPathForRuntime(hostPath: string): string {
    return hostPath.replace(/\\/g, '/')
  }

  /**
   * Build a -v flag value for a volume mount.
   * Encapsulates hostPathForRuntime() + getVolumeMountSuffix().
   */
  public buildVolumeFlag(hostPath: string, containerPath: string): string {
    // hostPath is user-controlled (a selected mount). shellEscape() (not raw
    // double quotes) so a path like `/tmp/a$(...)` can't trigger command
    // substitution when start() runs the joined command through a real shell.
    return shellEscape(`${this.hostPathForRuntime(hostPath)}:${containerPath}${this.getVolumeMountSuffix()}`)
  }

  /**
   * Returns resource limit flags for the container.
   * Subclasses can override if the runtime uses different flag syntax.
   */
  protected getResourceFlags(cpu: number, memory: string): string {
    return `--cpus=${cpu} --memory=${memory}`
  }

  /**
   * Called when `container run` fails. Subclasses can override to attempt recovery
   * (e.g., configuring a missing kernel). Return true if recovery was performed and
   * the run should be retried.
   */
  protected async handleRunError(_error: any): Promise<boolean> {
    return false
  }

  /**
   * Whether a run failure is a host-port allocation race. The chosen port passed
   * findAvailablePort()'s pre-flight bind but was grabbed (or published on a
   * different interface) before `run -p` claimed it. Recoverable by re-picking a
   * port. Matches Docker, nerdctl/containerd, and Podman phrasings.
   */
  protected isPortConflictError(error: any): boolean {
    const msg = String(error?.message || error?.stderr || error || '')
    return (
      /port is already allocated/i.test(msg) ||
      /address already in use/i.test(msg) ||
      /Bind for .* failed/i.test(msg) ||
      /failed to bind host port/i.test(msg)
    )
  }

  /**
   * If a run failure is caused by a bind mount the runtime can't access, return
   * the offending host path so start() can drop that one mount and retry without
   * it. Default: never (most runtimes share the host filesystem directly).
   * VM-based runtimes (Lima) override to parse EPERM-on-stat for cloud-synced
   * mounts that the VM helper is denied access to.
   */
  protected extractInaccessibleMountPath(_error: any): string | null {
    return null
  }

  protected getContainerName(): string {
    return `superagent-${this.config.agentId}`
  }

  /**
   * Query the container runtime for the current container state.
   * This spawns a CLI process - prefer containerManager.getCachedInfo() for cached status.
   */
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const containerName = this.getContainerName()
    const runner = this.getRunnerShellCommand()
    try {
      const { stdout } = await execWithPath(
        `${runner} inspect ${containerName}`
      )
      const inspectData = JSON.parse(stdout.trim())
      const container = Array.isArray(inspectData) ? inspectData[0] : inspectData
      const running = container?.State?.Running === true
      const portKey = `${CONTAINER_INTERNAL_PORT}/tcp`
      const portBindings = container?.NetworkSettings?.Ports?.[portKey]
      const hostPort = portBindings?.[0]?.HostPort
      return {
        status: running ? 'running' : 'stopped',
        port: hostPort ? parseInt(hostPort, 10) : null,
      }
    } catch {
      return { status: 'stopped', port: null }
    }
  }

  /**
   * Alias for getInfoFromRuntime().
   * @deprecated Use containerManager.getCachedInfo() for cached status instead.
   */
  async getInfo(): Promise<ContainerInfo> {
    return this.getInfoFromRuntime()
  }

  /**
   * Get the last N lines of container logs. Useful for diagnosing startup failures.
   */
  async getLogs(tail: number = 50): Promise<string> {
    const containerName = this.getContainerName()
    const runner = this.getRunnerShellCommand()
    try {
      const { stdout, stderr } = await execWithPath(
        `${runner} logs --tail ${tail} ${containerName}`
      )
      // Docker sends stdout/stderr separately; combine them
      return (stdout + stderr).trim()
    } catch {
      return ''
    }
  }

  /**
   * Get container resource usage stats (memory, CPU).
   * Returns null if the container is not running or stats are unavailable.
   */
  async getStats(): Promise<ContainerStats | null> {
    const containerName = this.getContainerName()
    const runner = this.getRunnerShellCommand()
    try {
      const { stdout } = await execWithPath(
        `${runner} stats ${containerName} --no-stream --format ${shellQuote('{{json .}}')}`
      )
      const stats = JSON.parse(stdout.trim())

      const memPercent = parseFloat(String(stats.MemPerc).replace('%', '')) || 0
      const cpuPercent = parseFloat(String(stats.CPUPerc).replace('%', '')) || 0

      // Parse MemUsage like "231.2MiB / 512MiB"
      const memUsageParts = String(stats.MemUsage).split('/')
      const memoryUsageBytes = parseMemoryValue(memUsageParts[0]?.trim() || '0')
      const memoryLimitBytes = parseMemoryValue(memUsageParts[1]?.trim() || '0')

      return { memoryUsageBytes, memoryLimitBytes, memoryPercent: memPercent, cpuPercent }
    } catch {
      return null
    }
  }

  /**
   * Find a free host port to publish the container on.
   * `exclude` lets a retry skip ports that just lost a publish race even if
   * they momentarily look free again to the pre-flight bind.
   */
  private async findAvailablePort(exclude?: Set<number>): Promise<number> {
    const usedPorts = await this.getUsedPorts()

    let port = BASE_PORT
    while (usedPorts.has(port) || exclude?.has(port) || !(await this.isPortAvailable(port))) {
      port++
    }
    return port
  }

  protected async getUsedPorts(): Promise<Set<number>> {
    const usedPorts = new Set<number>()
    const runner = this.getRunnerShellCommand()
    try {
      const { stdout } = await execWithPath(
        `${runner} ps --format ${shellQuote('{{.Ports}}')}`
      )

      const portRegex = /:(\d+)->/g
      let match
      while ((match = portRegex.exec(stdout)) !== null) {
        usedPorts.add(parseInt(match[1], 10))
      }
    } catch {
      // If command fails, continue with empty set
    }
    return usedPorts
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close()
        resolve(true)
      })
      // Bind 0.0.0.0 to match docker/nerdctl's publish address — a 127.0.0.1
      // bind would miss a conflict from a process already on 0.0.0.0:<port>.
      server.listen(port, '0.0.0.0')
    })
  }

  async start(options?: StartOptions): Promise<void> {
    const info = await this.getInfo()
    if (info.status === 'running') {
      console.log(`Container ${this.getContainerName()} is already running on port ${info.port}`)
      return
    }

    addErrorBreadcrumb({ category: 'container', message: 'Starting container', data: { agentId: this.config.agentId } })

    try {
      const settings = getSettings()
      const runner = this.getRunnerShellCommand()
      const image = settings.container.agentImage
      const { cpu, memory } = settings.container.resourceLimits

      // Ensure image exists (build if not), self-healing the runtime if the
      // build fails because the VM is dirty/unreachable (SUP-291).
      await this.ensureImageExistsWithRecovery()

      // Ensure workspace directory exists for persistent storage
      const workspaceDir = getAgentWorkspaceDir(this.config.agentId)
      fs.mkdirSync(workspaceDir, { recursive: true })

      // Find an available port
      let port = await this.findAvailablePort()

      // Write env vars to a temp file (avoids command length limits on Windows)
      const { flag: envFileFlag, cleanup: cleanupEnvFile } = this.buildEnvFile(options?.envVars)
      const containerName = this.getContainerName()

      // Build resource limit flags
      const resourceFlags = this.getResourceFlags(cpu, memory)
      const additionalFlags = this.getAdditionalRunFlags()

      // Mutable copy of bind-mount flags — an inaccessible mount (e.g. a
      // cloud-synced folder the VM helper is denied) is dropped from this list
      // on retry so the container can still start without it.
      let volumes = [...(options?.additionalVolumes || [])]

      const buildRunCmd = () =>
        [
          runner, 'run', '-d',
          '--name', containerName,
          '-p', `${port}:${CONTAINER_INTERNAL_PORT}`,
          '-v', shellEscape(`${this.hostPathForRuntime(workspaceDir)}:/workspace${this.getVolumeMountSuffix()}`),
          ...volumes.flatMap(v => ['-v', v]),
          resourceFlags,
          additionalFlags,
          envFileFlag,
          image,
        ].filter(Boolean).join(' ')

      // Bounded retry loop. Each recovery path makes exactly one attempt of
      // progress so the loop can't spin: dropping a mount shrinks `volumes`,
      // re-picking a port is capped by portRetries, and VM provisioning runs
      // once. A fresh stop+rm precedes every attempt so we never double-start.
      const MAX_PORT_RETRIES = 3
      let portRetries = 0
      const triedPorts = new Set<number>([port])
      let vmRecoveryTried = false
      let stdout: string
      try {
        for (;;) {
          await execWithPathSilent(`${runner} stop ${containerName}`)
          await execWithPathSilent(`${runner} rm ${containerName}`)

          try {
            ({ stdout } = await execWithPath(buildRunCmd()))
            break
          } catch (runError: any) {
            // 1. Inaccessible bind mount (e.g. iCloud/File Provider path the VM
            //    can't stat). Drop that one mount and retry without it.
            const badMountPath = this.extractInaccessibleMountPath(runError)
            if (badMountPath) {
              const before = volumes.length
              volumes = volumes.filter((v) => !v.includes(badMountPath))
              if (volumes.length < before) {
                console.warn(`[Container] Dropping inaccessible mount and retrying: ${badMountPath}`)
                addErrorBreadcrumb({ category: 'container', message: 'Dropped inaccessible mount, retrying', data: { hostPath: badMountPath, agentId: this.config.agentId } })
                options?.onMountDropped?.(badMountPath)
                continue
              }
            }

            // 2. Host-port allocation race — re-pick a port (bounded).
            if (this.isPortConflictError(runError) && portRetries < MAX_PORT_RETRIES) {
              portRetries++
              const newPort = await this.findAvailablePort(triedPorts)
              triedPorts.add(newPort)
              console.warn(`[Container] Port ${port} unavailable (attempt ${portRetries}/${MAX_PORT_RETRIES}), retrying on ${newPort}`)
              addErrorBreadcrumb({ category: 'container', message: 'Port conflict, retrying with new port', data: { oldPort: port, newPort, attempt: portRetries, agentId: this.config.agentId } })
              port = newPort
              continue
            }

            // 3. Subclass recovery (e.g. provisioning a missing VM) — once.
            if (!vmRecoveryTried) {
              vmRecoveryTried = true
              const recovered = await this.handleRunError(runError)
              if (recovered) continue
            }

            throw runError
          }
        }
      } finally {
        cleanupEnvFile()
      }

      console.log(`Started container ${stdout.trim()} on port ${port}`)

      // Wait for container to be healthy
      addErrorBreadcrumb({ category: 'container', message: 'Waiting for container health check', data: { port, containerName } })
      const healthy = await this.waitForHealthy(60000, port)
      if (!healthy) {
        // Grab logs to help diagnose the failure
        const logs = await this.getLogs(30)
        const logsSnippet = logs ? `\n\nContainer logs:\n${logs}` : ''
        const healthError = new Error(`Container failed to become healthy${logsSnippet}`)
        captureException(healthError, {
          tags: { component: 'container', operation: 'health-check' },
          extra: {
            agentId: this.config.agentId,
            containerName,
            port,
            image,
            runner: settings.container.containerRunner,
            cpu,
            memory,
            containerLogs: logs,
          },
        })
        // Stop + remove the just-created-but-unhealthy container. Otherwise it
        // stays process-alive, and the next start() short-circuits on the
        // running-status early return (getInfoFromRuntime derives 'running'
        // from inspect's State.Running, not /health), caching a container that
        // never became healthy. Best-effort/silent so an already-gone container
        // is harmless and cleanup failure never masks the health error. Logs
        // were already captured above, before this removes the container.
        await execWithPathSilent(`${runner} stop ${containerName}`)
        await execWithPathSilent(`${runner} rm ${containerName}`)
        throw healthError
      }

      console.log(`Container ${containerName} is now running on port ${port}`)
    } catch (error: any) {
      // Only capture if not already captured (health check errors are captured above)
      if (!error.message?.includes('Container failed to become healthy')) {
        // Port races are a handled, user-environment failure — we retried with
        // fresh ports and only land here after exhausting them. Downgrade to a
        // warning so it doesn't page as a hard error.
        const isHandledEnvFailure = this.isPortConflictError(error)
        captureException(error, {
          tags: { component: 'container', operation: 'start' },
          ...(isHandledEnvFailure ? { level: 'warning' as const } : {}),
          extra: {
            agentId: this.config.agentId,
            containerName: this.getContainerName(),
            runner: getSettings().container.containerRunner,
            image: getSettings().container.agentImage,
            // Surface image-build diagnostics when start() failed during
            // ensureImageExists() (otherwise these are undefined).
            imageBuildExitCode: error.imageBuildExitCode,
            imageBuildStderr: error.imageBuildStderr,
          },
        })
      }
      console.error('Failed to start container:', error)
      this.safeEmitError(error)
      throw error
    }
  }

  protected terminateWebSocketConnections(): void {
    for (const ws of this.wsConnections.values()) {
      ws.removeAllListeners()
      try {
        ws.terminate()
      } catch {
        // ws.terminate() throws if the socket is still in CONNECTING state.
      }
    }
    this.wsConnections.clear()
  }

  async stop(options?: StopOptions): Promise<StopResult> {
    let forceStopUsed = false
    const stopTimeoutMs = options?.stopTimeoutMs ?? 10_000
    const killTimeoutMs = options?.killTimeoutMs ?? 5_000
    const escalateToForceStop = options?.escalateToForceStop ?? true

    try {
      this.terminateWebSocketConnections()

      // Stop and remove container by name, with escalation if the container is unresponsive.
      // 1. Try graceful stop with 5s SIGTERM grace period (enough for clean Node.js shutdown)
      // 2. If that times out (e.g., VM is overloaded), escalate to kill (immediate SIGKILL)
      // 3. If kill also fails, call forceStop() hook (e.g., Lima kills the VM directly)
      // 4. Remove the container
      const runner = this.getRunnerShellCommand()
      const containerName = this.getContainerName()

      const stopped = await Promise.race([
        execWithPathSilent(`${runner} stop -t 5 ${containerName}`).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), stopTimeoutMs)),
      ])

      if (!stopped) {
        console.warn(`Container ${containerName} did not stop gracefully, escalating to kill`)
        addErrorBreadcrumb({ category: 'container', message: 'Graceful stop timed out, escalating to kill', data: { containerName, agentId: this.config.agentId } })
        const killed = await Promise.race([
          execWithPathSilent(`${runner} kill ${containerName}`).then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), killTimeoutMs)),
        ])

        if (!killed) {
          console.warn(
            `Container ${containerName} kill also timed out` +
              (escalateToForceStop
                ? ', attempting force stop'
                : ' (force-stop disabled — leaving container running, will retry)')
          )

          // Probe why stop+kill hung so we can learn the root cause. Best-effort
          // and bounded — a probe timing out is itself a signal the runtime is
          // wedged. Collected on EVERY occurrence (including auto-sleep bails),
          // not just real escalations. Diagnostics are telemetry only and must
          // never be load-bearing: if collection throws, degrade to a marker so
          // the capture and the escalation/bail decision below still proceed.
          let stopFailureDiagnostics: Record<string, unknown>
          try {
            stopFailureDiagnostics = await this.collectStopFailureDiagnostics(containerName)
          } catch (diagError: any) {
            stopFailureDiagnostics = {
              diagnostics_collection_failed: String(diagError?.message ?? diagError).slice(0, 300),
            }
          }
          captureException(new Error(`Container stop escalated to forceStop: both stop and kill timed out`), {
            tags: {
              component: 'container',
              operation: 'stop-escalation',
              // Distinguish deliberate escalations from auto-sleep bails so the
              // two can be split/filtered in Sentry while sharing one issue.
              escalation: escalateToForceStop ? 'forced' : 'skipped',
            },
            extra: {
              containerName,
              agentId: this.config.agentId,
              runner: getSettings().container.containerRunner,
              stopTimeoutMs,
              killTimeoutMs,
              escalateToForceStop,
              ...stopFailureDiagnostics,
            },
            level: 'warning',
          })

          if (!escalateToForceStop) {
            // Background auto-sleep: never kill the shared VM to reclaim one idle
            // container. Leave it running (don't `rm` it — it's still alive) and
            // let the next sweep retry.
            addErrorBreadcrumb({
              category: 'container',
              message: 'Stop failed but force-stop disabled; leaving container running',
              data: { containerName, agentId: this.config.agentId },
            })
            return { forceStopUsed: false, stopped: false }
          }

          await this.forceStop()
          forceStopUsed = true
        }
      }

      await execWithPathSilent(`${runner} rm ${containerName}`)

      console.log(`Stopped container ${containerName}`)
    } catch (error: any) {
      console.error('Failed to stop container:', error)
      this.safeEmitError(error)
      throw error
    }

    return { forceStopUsed, stopped: true }
  }

  /**
   * Collect diagnostic data at the moment a stop fails (both `stop` and `kill`
   * timed out). Attached to the Sentry report to surface why the runtime is
   * unresponsive. Default is a no-op; VM-based runtimes override to probe the
   * guest (load, memory, container/runtime state). Must be best-effort and
   * bounded — the runtime is likely wedged when this runs.
   */
  protected async collectStopFailureDiagnostics(_containerName: string): Promise<Record<string, unknown>> {
    return {}
  }

  /**
   * Last-resort force stop when both `stop` and `kill` fail (e.g., VM is unresponsive).
   * Subclasses can override to kill the VM directly.
   * No-op by default for runtimes like Docker/Podman where kill should always work.
   */
  protected async forceStop(): Promise<void> {
    // No-op — subclasses override for VM-based runtimes
  }

  stopSync(): void {
    try {
      this.terminateWebSocketConnections()

      // Stop and remove container by name synchronously, with escalation.
      // Use 5s grace period so process can shut down cleanly before SIGKILL.
      const runner = this.getRunnerShellCommand()
      const containerName = this.getContainerName()
      try {
        execSyncWithPath(`${runner} stop -t 5 ${containerName}`, { stdio: 'pipe', timeout: 10000 })
      } catch {
        // Graceful stop failed or timed out — escalate to kill
        try {
          execSyncWithPath(`${runner} kill ${containerName}`, { stdio: 'pipe', timeout: 5000 })
        } catch {
          // Container might not exist or already stopped
        }
      }
      try {
        execSyncWithPath(`${runner} rm ${containerName}`, { stdio: 'pipe', timeout: 5000 })
      } catch {
        // Container might not exist, ignore
      }

      console.log(`Stopped container ${containerName} (sync)`)
    } catch (error) {
      console.error('Failed to stop container (sync):', error)
    }
  }

  async waitForHealthy(timeoutMs: number = 30000, knownPort?: number): Promise<boolean> {
    const startTime = Date.now()
    const pollInterval = 250
    // Only check container exit status every ~2s to avoid spawning docker inspect on every tick
    const exitCheckInterval = 2000
    let lastExitCheck = 0

    while (Date.now() - startTime < timeoutMs) {
      if (await this.isHealthy(knownPort)) {
        return true
      }

      // Periodically check if the container has exited so we can fail fast
      const now = Date.now()
      if (now - lastExitCheck >= exitCheckInterval) {
        lastExitCheck = now
        const info = await this.getInfo()
        if (info.status !== 'running') {
          return false
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    return false
  }

  async isHealthy(knownPort?: number): Promise<boolean> {
    const port = knownPort ?? (await this.getInfo()).port
    if (!port) return false
    try {
      // Bound the probe: this runs on the request hot path (ensureRunning's
      // stale-cache liveness check), and a container that died with its port
      // forward left half-open would accept the TCP connect but never respond,
      // hanging the fetch — and the caller — indefinitely without this.
      const response = await fetch(`${this.getBaseUrl(port)}/health`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      })
      return response.ok
    } catch {
      // Includes AbortError on timeout — treat an unresponsive probe as unhealthy.
      return false
    }
  }

  private async getPortOrThrow(): Promise<number> {
    const info = await this.getInfo()
    if (info.status !== 'running' || !info.port) {
      // Container is not running - trigger connection error handler
      // so the manager can sync status and broadcast to UI
      this.handleConnectionError()
      throw new Error('Container is not running')
    }
    return info.port
  }

  /**
   * Returns the base URL for HTTP requests to the container.
   * Subclasses can override for different networking (e.g., cloud containers).
   */
  protected getBaseUrl(port: number): string {
    return `http://127.0.0.1:${port}`
  }

  public getWebSocketBaseUrl(port: number): string {
    return `ws://127.0.0.1:${port}`
  }

  public getHostApiBaseUrl(): string {
    return `http://${getContainerHostUrl()}:${getAppPort()}`
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const port = await this.getPortOrThrow()
    const baseUrl = this.getBaseUrl(port)
    const url = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`

    try {
      return await fetch(url, init)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      if (this.isConnectionError(err)) {
        this.handleConnectionError()
      }

      throw err
    }
  }

  async createSession(options: CreateSessionOptions): Promise<ContainerSession> {
    const port = await this.getPortOrThrow()
    const timeoutMs = 60000 // 60 second timeout

    // Resolve stored selections (bare aliases or concrete ids) to the active
    // provider's concrete wire id before the container ever sees them.
    const resolvedModel = resolveContainerModel(options.model, 'agent')
    const resolvedBrowserModel = resolveContainerModel(options.browserModel, 'browser')
    const resolvedDashboardBuilderModel = resolveContainerModel(options.dashboardBuilderModel, 'dashboard')
    const modelPromptHints = getContainerModelPromptHints(resolvedModel)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(`${this.getBaseUrl(port)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: options.metadata,
          systemPrompt: options.systemPrompt,
          modelPromptHints: modelPromptHints.length > 0 ? modelPromptHints : undefined,
          availableEnvVars: options.availableEnvVars,
          initialMessage: options.initialMessage,
          initialMessageUuid: options.initialMessageUuid,
          model: resolvedModel,
          browserModel: resolvedBrowserModel,
          dashboardBuilderModel: resolvedDashboardBuilderModel,
          maxOutputTokens: options.maxOutputTokens,
          maxThinkingTokens: options.maxThinkingTokens,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          customEnvVars: options.customEnvVars,
          maxBrowserTabs: options.maxBrowserTabs,
          effort: options.effort,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        // Try to get more details from response body
        let errorDetail = ''
        try {
          const errorBody = await response.text()
          if (errorBody) {
            // Parse JSON error if possible
            try {
              const parsed = JSON.parse(errorBody)
              errorDetail = parsed.error || errorBody
            } catch {
              errorDetail = errorBody
            }
          }
        } catch {
          errorDetail = response.statusText
        }

        // Check for known error patterns and provide user-friendly messages
        if (errorDetail.includes('Timeout waiting for Claude session')) {
          throw new Error(
            'Failed to start session - the AI service is taking too long to respond. This may be due to network issues or high API load. Please try again.'
          )
        }

        throw new Error(`Failed to create session: ${errorDetail || response.statusText}`)
      }

      return response.json()
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      // Handle abort/timeout
      if (err.name === 'AbortError') {
        throw new Error(
          'Failed to start session - request timed out. This may be due to network issues or the AI service being slow. Please try again.'
        )
      }

      // Handle network errors with user-friendly messages
      if (this.isConnectionError(err)) {
        this.handleConnectionError()
        throw new Error(
          'Failed to start session - unable to connect to the agent. Please check that the agent is running and try again.'
        )
      }

      // Re-throw if already a user-friendly message
      throw err
    }
  }

  async getSession(sessionId: string): Promise<ContainerSession | null> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `${this.getBaseUrl(port)}/sessions/${sessionId}`
    )

    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.statusText}`)
    }

    return response.json()
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const port = await this.getPortOrThrow()

    // Close WebSocket if exists
    const ws = this.wsConnections.get(sessionId)
    if (ws) {
      ws.close()
      this.wsConnections.delete(sessionId)
    }

    const response = await fetch(
      `${this.getBaseUrl(port)}/sessions/${sessionId}`,
      { method: 'DELETE' }
    )

    return response.ok
  }

  async sendMessage(sessionId: string, content: string, uuid?: string, options?: RuntimeOptions): Promise<void> {
    const port = await this.getPortOrThrow()
    const timeoutMs = 30000 // 30 second timeout
    const effort = options?.effort
    const model = resolveContainerModel(options?.model, 'agent')
    const shouldQuery = options?.shouldQuery

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      const response = await fetch(
        `${this.getBaseUrl(port)}/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            ...(uuid ? { uuid } : {}),
            ...(effort ? { effort } : {}),
            ...(model ? { model } : {}),
            ...(shouldQuery !== undefined ? { shouldQuery } : {}),
          }),
          signal: controller.signal,
        }
      )

      clearTimeout(timeoutId)

      if (!response.ok) {
        let errorDetail = ''
        try {
          const errorBody = await response.text()
          if (errorBody) {
            try {
              const parsed = JSON.parse(errorBody)
              errorDetail = parsed.error || errorBody
            } catch {
              errorDetail = errorBody
            }
          }
        } catch {
          errorDetail = response.statusText
        }
        throw new Error(`Failed to send message: ${errorDetail || response.statusText}`)
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      if (err.name === 'AbortError') {
        throw new Error(
          'Failed to send message - request timed out. Please check your connection and try again.'
        )
      }

      if (this.isConnectionError(err)) {
        this.handleConnectionError()
        throw new Error(
          'Failed to send message - connection lost. Please check that the agent is running and try again.'
        )
      }

      throw err
    }
  }

  async cancelQueuedMessage(sessionId: string, uuid: string): Promise<boolean> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/queued-messages/${encodeURIComponent(uuid)}`,
      { method: 'DELETE' }
    )
    if (response.status === 404) {
      // Route missing = the container is running a build that predates the
      // cancel endpoint. Restart the agent so a fresh container is created
      // from the current image.
      console.warn(
        '[ContainerClient] cancelQueuedMessage: container returned 404 — the agent container predates the cancel endpoint; restart the agent to pick up the current image'
      )
      return false
    }
    if (!response.ok) {
      console.warn(`[ContainerClient] cancelQueuedMessage: container returned ${response.status}`)
      return false
    }
    const body = (await response.json()) as { cancelled?: boolean }
    return body.cancelled === true
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `${this.getBaseUrl(port)}/sessions/${sessionId}/interrupt`,
      { method: 'POST' }
    )

    return response.ok
  }

  async getMessages(sessionId: string): Promise<any[]> {
    const port = await this.getPortOrThrow()

    const response = await fetch(
      `${this.getBaseUrl(port)}/sessions/${sessionId}/messages`
    )

    if (!response.ok) {
      throw new Error(`Failed to get messages: ${response.statusText}`)
    }

    return response.json()
  }

  subscribeToStream(
    sessionId: string,
    callback: (message: StreamMessage) => void
  ): { unsubscribe: () => void; ready: Promise<void> } {
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const setupWebSocket = async () => {
      const port = await this.getPortOrThrow()

      const existing = this.wsConnections.get(sessionId)
      if (existing) {
        existing.close()
      }

      const ws = new WebSocket(
        `${this.getWebSocketBaseUrl(port)}/sessions/${sessionId}/stream`
      )

      ws.on('open', () => {
        console.log(`WebSocket connected for session ${sessionId}`)
        resolveReady()
      })

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          const streamMessage: StreamMessage = {
            type: message.type,
            content: message,
            timestamp: new Date(message.timestamp || Date.now()),
            sessionId,
          }
          callback(streamMessage)
          this.emit('message', sessionId, message)
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error)
        }
      })

      ws.on('error', (error) => {
        // Only log and emit if this connection is still tracked (not cleaned up by stop())
        if (this.wsConnections.has(sessionId)) {
          console.error(`WebSocket error for session ${sessionId}:`, error)
          this.safeEmitError(error)
        }
        rejectReady(error instanceof Error ? error : new Error(String(error)))
      })

      ws.on('close', () => {
        console.log(`WebSocket closed for session ${sessionId}`)
        this.wsConnections.delete(sessionId)
        // Notify the callback that the connection was lost
        // This allows the message persister to handle the disconnection
        const closeMessage: StreamMessage = {
          type: 'connection_closed',
          content: { type: 'connection_closed' },
          timestamp: new Date(),
          sessionId,
        }
        callback(closeMessage)
      })

      this.wsConnections.set(sessionId, ws)
    }

    setupWebSocket().catch((error) => {
      console.error('Failed to set up WebSocket:', error)
      this.safeEmitError(error)
      // Notify the callback so the consumer (e.g. MessagePersister) can react to
      // the failed (re)subscribe instead of relying on the `ready` promise —
      // callers that discard `ready` (e.g. reconnect) would otherwise leave a
      // free-floating rejected promise and never learn the session is gone.
      const closeMessage: StreamMessage = {
        type: 'connection_closed',
        content: { type: 'connection_closed' },
        timestamp: new Date(),
        sessionId,
      }
      callback(closeMessage)
      rejectReady(error instanceof Error ? error : new Error(String(error)))
    })

    const unsubscribe = () => {
      const ws = this.wsConnections.get(sessionId)
      if (ws) {
        ws.close()
        this.wsConnections.delete(sessionId)
      }
    }

    return { unsubscribe, ready }
  }

  /**
   * Remove old images for a given registry, keeping only the specified current tag.
   * Each image is removed individually so in-use images don't block others.
   * Best-effort: never throws.
   * Subclasses can override for runtimes with different CLI syntax.
   */
  static async removeOldImages(cliCommand: string, registry: string, currentTag: string): Promise<void> {
    try {
      const { stdout } = await execWithPath(
        `${cliCommand} images --format "{{.Repository}}:{{.Tag}}"`
      )
      const currentImage = `${registry}:${currentTag}`
      const imagesToRemove = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l !== currentImage && l.startsWith(registry + ':'))

      if (imagesToRemove.length === 0) return

      console.log(`[ContainerManager] Removing ${imagesToRemove.length} old image(s):`, imagesToRemove)
      for (const img of imagesToRemove) {
        try {
          await execWithPath(`${cliCommand} rmi ${img}`)
          console.log(`[ContainerManager] Removed ${img}`)
        } catch {
          console.warn(`[ContainerManager] Could not remove ${img} (may be in use)`)
        }
      }
    } catch (error) {
      console.warn('[ContainerManager] Failed to remove old images:', error)
    }
  }

  /**
   * Ensure the agent image exists, giving the BUILD step the same one-shot
   * runtime recovery the container-run step gets.
   *
   * The build runs before start()'s run-retry loop, so a dirty/unreachable
   * runtime here (e.g. a Lima VM with a missing ha.sock after a force-kill)
   * fails the build with no recovery — which is how a scheduled task firing
   * against a not-yet-healed VM hard-fails instead of self-healing (SUP-291).
   * handleRunError() self-heals when it can and is a no-op for runners that
   * can't (returns false → original build error rethrown), so this is safe for
   * docker/podman/etc. too.
   */
  protected async ensureImageExistsWithRecovery(): Promise<void> {
    try {
      await this.ensureImageExists()
    } catch (buildError) {
      if (!(await this.handleRunError(buildError))) throw buildError
      // Recovered (e.g. Lima VM cleaned + restarted) — retry the build once.
      await this.ensureImageExists()
    }
  }

  private async ensureImageExists(): Promise<void> {
    const settings = getSettings()
    const runner = this.getRunnerCommand()
    const image = settings.container.agentImage

    try {
      await execWithPath(`${this.getRunnerShellCommand()} image inspect ${image}`)
      console.log(`Container image ${image} found`)
    } catch {
      console.log(`Building container image ${image}...`)

      // Pipe (not inherit) stdout/stderr so we can capture the build output —
      // a bare exit code is undiagnosable in Sentry. Mirrors buildImage() in
      // client-factory.ts.
      const buildProcess = spawnWithPath(
        runner,
        ['build', '-t', image, AGENT_CONTAINER_PATH]
      )

      const stderrChunks: string[] = []
      buildProcess.stdout?.on('data', (data: Buffer) => process.stdout.write(data))
      buildProcess.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data.toString())
        process.stderr.write(data)
      })

      await new Promise<void>((resolve, reject) => {
        buildProcess.on('close', (code) => {
          const stderr = stderrChunks.join('').trim()
          // Treat an "already exists" image as success — a concurrent build
          // (e.g. ensureImageReady racing the start path) may have created it.
          if (code === 0 || /already exists/i.test(stderr)) {
            console.log(`Container image ${image} built successfully`)
            resolve()
          } else {
            const detail = stderr ? `: ${stderr.slice(-500)}` : ''
            const error = new Error(`Container build failed with code ${code}${detail}`) as ImageBuildError
            error.imageBuildExitCode = code
            error.imageBuildStderr = stderr.slice(-2000)
            reject(error)
          }
        })
        buildProcess.on('error', reject)
      })
    }
  }

  /**
   * The env every agent gets, independent of how a runtime delivers it (docker
   * env-file, k8s pod env, MicroVM runHookPayload). Defined once here; subclasses
   * only serialize the result into their transport. Merge order:
   * provider defaults < runtime constants < config.envVars < per-start extra.
   */
  protected buildAgentEnv(extra?: Record<string, string>): Record<string, string> {
    const settings = getSettings()
    const merged: Record<string, string | undefined> = {
      ...getActiveLlmProvider().getContainerEnvVars(),
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      ENABLE_TOOL_SEARCH: settings.enableToolSearch !== false ? 'true' : 'false',
      ...this.config.envVars,
      ...extra,
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) out[key] = value
    }
    return out
  }

  /**
   * Serialize the agent env to a temp --env-file (avoids shell-quoting issues and
   * Windows command-length limits). Caller cleans up the file after start.
   */
  protected buildEnvFile(additionalEnvVars?: Record<string, string>): { flag: string; cleanup: () => void } {
    return writeEnvFile(this.buildAgentEnv(additionalEnvVars), this.config.agentId)
  }
}
