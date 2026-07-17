import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir, freemem, totalmem } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { BaseContainerClient, execWithPath, execSyncWithPath, CONTAINER_INTERNAL_PORT, shellEscape } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, ImagePullProgress } from './types'
import { isAdminPrivilegeCancelError, runWithAdminPrivileges } from '@shared/lib/run-with-admin-privileges'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'
import { getAppPort } from '@shared/lib/proxy/host-url'

export type AppleContainerProvisionProgress = Pick<ImagePullProgress, 'status' | 'percent'>

const APPLE_CONTAINER_VERSION = '1.1.0' // pin; do not follow releases/latest
export const APPLE_CONTAINER_PKG_SHA256 =
  '0ca1c42a2269c2557efb1d82b1b38ac553e6a3a3da1b1179c439bcee1e7d6714'
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
/** CLI `--timeout` (seconds) for apiserver readiness; exec bound is slightly longer. */
const APPLE_SYSTEM_START_TIMEOUT_SEC = 60
const APPLE_SYSTEM_START_CMD =
  `container system start --enable-kernel-install --timeout ${APPLE_SYSTEM_START_TIMEOUT_SEC}`
const APPLE_SYSTEM_START_EXEC_TIMEOUT_MS = (APPLE_SYSTEM_START_TIMEOUT_SEC + 30) * 1000
const APPLE_SYSTEM_STOP_EXEC_TIMEOUT_MS = 15_000
/** `run` normally returns in seconds; a dataless iCloud mount hangs it for minutes. */
const APPLE_RUN_EXEC_TIMEOUT_MS = 120_000

let cachedMacOSMajorVersion: number | null | undefined = undefined // null failures not cached
let appleReadyPromise: Promise<void> | null = null
let appleReadyAllowsInstall = false

function getMacOSMajorVersion(): number | null {
  if (cachedMacOSMajorVersion !== undefined) {
    return cachedMacOSMajorVersion
  }
  if (process.platform !== 'darwin') {
    cachedMacOSMajorVersion = null
    return null
  }
  try {
    const output = execSync('sw_vers -productVersion', { timeout: 5000 }).toString().trim()
    const major = parseInt(output.split('.')[0], 10)
    if (!Number.isFinite(major)) return null
    cachedMacOSMajorVersion = major
    return major
  } catch {
    return null
  }
}

/**
 * Gateway IP of the default network — the vmnet host-side interface, and the
 * only address containers can reach the host at: Apple's runtime has no
 * --add-host equivalent and host.docker.internal does not resolve inside its
 * containers (verified NXDOMAIN on CLI 1.1.0). Cached per app session; the
 * default network's subnet is stable while the apiserver runs.
 */
let cachedGatewayIp: string | null = null
function getAppleGatewayIp(): string | null {
  if (cachedGatewayIp) return cachedGatewayIp
  try {
    const raw = execSyncWithPath('container network inspect default', { timeout: 10_000 }).toString()
    const nets = JSON.parse(raw)
    const gw = (Array.isArray(nets) ? nets[0] : nets)?.status?.ipv4Gateway
    cachedGatewayIp = typeof gw === 'string' && gw ? gw : null
  } catch {
    cachedGatewayIp = null
  }
  return cachedGatewayIp
}

/**
 * Collect diagnostic data about the Apple Container environment at the moment
 * of failure. Every probe is bounded and best-effort — this runs when the
 * runtime is likely already misbehaving.
 */
async function collectAppleContainerDiagnostics(): Promise<Record<string, unknown>> {
  const diag: Record<string, unknown> = {
    arch: process.arch,
    macos_major_version: getMacOSMajorVersion(),
    system_memory_free_mb: Math.round(freemem() / 1048576),
    system_memory_total_mb: Math.round(totalmem() / 1048576),
  }
  try {
    const { stdout } = await execWithPath('container --version', { timeoutMs: 5000 })
    diag.cli_version = stdout.trim()
  } catch (e: any) {
    diag.cli_version = `check_failed: ${String(e?.message ?? e).slice(0, 300)}`
  }
  try {
    const { stdout, stderr } = await execWithPath('container system status', { timeoutMs: 5000 })
    diag.system_status = (stdout + stderr).trim().slice(0, 500) || '(empty)'
  } catch (e: any) {
    diag.system_status = `check_failed: ${String(e?.message ?? e).slice(0, 300)}`
  }
  return diag
}

/**
 * The pinned installer is 1.1.0 and `system start --timeout` needs 1.1+;
 * pre-1.1 installs exist in the wild (SuperAgent supported Apple Containers
 * before 1.0) and fail every start. Unparseable output or a wedged binary
 * counts as unsupported: the Install path recovers by installing the pin.
 */
async function getInstalledCliState(): Promise<'absent' | 'unsupported' | 'supported'> {
  try {
    const { stdout } = await execWithPath('container --version', { timeoutMs: 5000 })
    const m = stdout.match(/(\d+)\.(\d+)\.\d+/)
    return m && Number(m[1]) === 1 && Number(m[2]) >= 1 ? 'supported' : 'unsupported'
  } catch (error: any) {
    return error?.code === 127 ? 'absent' : 'unsupported' // 127 = shell couldn't find the binary
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function downloadToFile(
  url: string,
  destPath: string,
  onBytes?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(`Timed out downloading Apple Container installer after ${DOWNLOAD_TIMEOUT_MS / 1000}s. Try again.`)
    }
    throw error
  }
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Apple Container installer (HTTP ${response.status}).`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
  let downloaded = 0
  const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length
      onBytes?.(downloaded, total)
      callback(null, chunk)
    },
  })
  await pipeline(nodeStream, progress, createWriteStream(destPath))
}

export const appleContainerProvisionIO = {
  downloadToFile,
  hashFileSha256,
}

/**
 * Apple Container implementation of ContainerClient.
 * Uses the `container` CLI available on macOS 26+ Apple silicon.
 */
export class AppleContainerClient extends BaseContainerClient {
  static readonly runnerName = 'apple-container'

  constructor(config: ContainerConfig) {
    super(config)
  }

  /** Apple silicon + macOS 26+. */
  static isEligible(): boolean {
    if (process.arch !== 'arm64') return false
    const version = getMacOSMajorVersion()
    return version !== null && version >= 26
  }

  protected getRunnerCommand(): string {
    return 'container'
  }

  /**
   * Handle run errors: install the recommended kernel on first use, and
   * restart the runtime when the real health probe says it's down.
   */
  protected async handleRunError(error: any): Promise<boolean> {
    const msg = error.message || error.stderr || String(error)
    addErrorBreadcrumb({ category: 'apple-container', message: 'Container run error', data: { error: msg, agentId: this.config.agentId } })

    if (msg.includes('kernel not configured')) {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
      console.log(`Apple Container kernel not configured for ${arch}, installing recommended kernel...`)
      await execWithPath(`container system kernel set --arch ${arch} --recommended`)
      return true
    }

    // No error-text heuristics: Apple's failure signatures are unmapped, so
    // only the real runtime probe decides recovery (SUP-291 pattern, mirrored
    // from Lima/WSL2). This also keeps registry-level pull/build error text
    // from ever triggering a spurious runtime restart. Unrecovered errors are
    // captured by start()'s catch; a failed restart is captured with
    // diagnostics inside ensureAppleContainerReadyImpl — no capture here.
    if (!(await AppleContainerClient.isRunning())) {
      console.log('Apple Container runtime unreachable after run error, attempting to start...')
      try {
        await ensureAppleContainerReady()
        return true
      } catch (err) {
        console.error('Failed to start Apple Container runtime:', err)
      }
    }

    // Our run exec bound fired while the runtime is healthy. error.killed is
    // set only when the exec API itself killed the child (the timeoutMs
    // bound), never for an external kill. Likeliest cause is a mount stuck
    // materializing dataless iCloud files (Desktop & Documents sync lives
    // outside the rejected cloud prefixes) - name it as likely, not certain.
    if (error?.killed && error?.signal === 'SIGKILL') {
      throw new Error(
        'Container start timed out after 2 minutes. This can happen when a folder attached to this agent is stored in iCloud but not downloaded on this Mac - download it or remove it, then try again.',
      )
    }
    return false
  }

  /** See APPLE_RUN_EXEC_TIMEOUT_MS: bound `run` so a dataless mount can't hang startup. */
  protected getRunExecTimeoutMs(): number {
    return APPLE_RUN_EXEC_TIMEOUT_MS
  }

  /**
   * Override: Apple's `container inspect` outputs JSON without --format support.
   * Parse the JSON to extract running state and port mappings.
   */
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    const containerName = this.getContainerName()
    const runner = this.getRunnerCommand()
    try {
      const { stdout } = await execWithPath(`${runner} inspect ${containerName}`)
      const data = JSON.parse(stdout)

      // Handle both possible formats: single object or array of objects
      const info = Array.isArray(data) ? data[0] : data

      // Apple Container 1.x: status is `{ state: 'running', ... }`.
      // Older shape used a string; accept both.
      const state =
        typeof info?.status === 'string' ? info.status : info?.status?.state
      const isRunning = state === 'running'

      // Extract port mappings (Apple uses configuration.publishedPorts)
      let port: number | null = null
      const publishedPorts = info?.configuration?.publishedPorts
      if (Array.isArray(publishedPorts)) {
        const mapping = publishedPorts.find(
          (p: any) => p.containerPort === CONTAINER_INTERNAL_PORT
        )
        if (mapping?.hostPort) {
          port = mapping.hostPort
        }
      }

      return {
        status: isRunning ? 'running' : 'stopped',
        port,
      }
    } catch {
      return { status: 'stopped', port: null }
    }
  }

  /**
   * Override: Apple's `container list` uses --format json instead of Go templates.
   */
  protected async getUsedPorts(): Promise<Set<number>> {
    const usedPorts = new Set<number>()
    const runner = this.getRunnerCommand()
    try {
      const { stdout } = await execWithPath(`${runner} list --format json`)
      const containers = JSON.parse(stdout)
      if (Array.isArray(containers)) {
        for (const c of containers) {
          // Apple Container uses configuration.publishedPorts
          const ports = c.configuration?.publishedPorts || []
          if (Array.isArray(ports)) {
            for (const p of ports) {
              if (p.hostPort) usedPorts.add(p.hostPort)
            }
          }
        }
      }
    } catch {
      // If command fails, continue with empty set
    }
    return usedPorts
  }

  /**
   * Apple's CLI has no `stats` subcommand, so read the guest's own meters via
   * `container exec` instead. Each Apple container is its own lightweight VM,
   * so the guest's MemTotal IS the container's memory cap and
   * MemTotal - MemAvailable the usage under it — without this the health
   * monitor silently skips Apple-backed agents and no memory-pressure
   * warnings are ever produced.
   */
  async getStats(): Promise<ContainerStats | null> {
    try {
      const { stdout } = await execWithPath(
        `${this.getRunnerShellCommand()} exec ${this.getContainerName()} cat /proc/meminfo`,
        { timeoutMs: 5000 },
      )
      const memTotalKb = parseInt(stdout.match(/MemTotal:\s+(\d+)/i)?.[1] ?? '', 10)
      const memAvailableKb = parseInt(stdout.match(/MemAvailable:\s+(\d+)/i)?.[1] ?? '', 10)
      if (!(memTotalKb > 0) || !Number.isFinite(memAvailableKb)) return null
      const usedKb = Math.max(0, memTotalKb - memAvailableKb)
      return {
        memoryUsageBytes: usedKb * 1024,
        memoryLimitBytes: memTotalKb * 1024,
        memoryPercent: (usedKb / memTotalKb) * 100,
        // Not measured — the only stats consumer (memoryHealthChecker) ignores it.
        cpuPercent: 0,
      }
    } catch {
      return null
    }
  }

  /**
   * Containers talk back to the host (LLM proxy, host API) at this URL.
   * host.docker.internal doesn't resolve here, so use the gateway IP — the
   * same address Lima aliases that name to via --add-host. Fail closed if
   * the gateway is unknown: the Docker fallback is NXDOMAIN inside Apple
   * containers and would start agents with a permanently unreachable proxy.
   */
  public getHostApiBaseUrl(): string {
    const gateway = getAppleGatewayIp()
    if (!gateway) {
      throw new Error(
        'macOS Container host gateway is unreachable. Restart macOS Container and try again.',
      )
    }
    return `http://${gateway}:${getAppPort()}`
  }

  /** The vmnet gateway is a real host interface — the host-browser CDP proxy
   *  must bind it for the container to reach the browser stream (SUP-217). */
  getHostBridgeIp(): string | null {
    return getAppleGatewayIp()
  }

  /** Apple's `logs` takes `-n`, not Docker's `--tail` — the inherited form
   *  exits 64, so startup-failure reports would carry no container logs. */
  async getLogs(tail: number = 50): Promise<string> {
    try {
      const { stdout, stderr } = await execWithPath(
        `${this.getRunnerShellCommand()} logs -n ${tail} ${this.getContainerName()}`,
      )
      return (stdout + stderr).trim()
    } catch {
      return ''
    }
  }

  /**
   * Probe why `stop` + `kill` hung. Each probe is individually bounded — a
   * probe timing out is itself a signal the runtime is wedged. All best-effort.
   */
  protected async collectStopFailureDiagnostics(containerName: string): Promise<Record<string, unknown>> {
    const diag: Record<string, unknown> = await collectAppleContainerDiagnostics()
    const probe = async (key: string, command: string): Promise<void> => {
      try {
        const { stdout, stderr } = await execWithPath(command, { timeoutMs: 4000 })
        diag[key] = (stdout + stderr).trim().slice(0, 2000) || '(empty)'
      } catch (e: any) {
        diag[key] = `probe_failed: ${String(e?.message ?? e).slice(0, 200)}`
      }
    }
    const runner = this.getRunnerShellCommand()
    await Promise.all([
      probe('container_state', `${runner} inspect ${containerName}`),
      probe('containers_list', `${runner} list --format json`),
      probe('container_logs_tail', `${runner} logs -n 20 ${containerName}`),
    ])
    return diag
  }

  /**
   * Last-resort kill when both `stop` and `kill` time out. Each Apple
   * container is its own VM, so force-deleting the container tears that VM
   * down directly — the per-container analog of Lima killing its shared VM
   * process. Bounded so a wedged runtime can't hang the shutdown path.
   */
  protected async forceStop(): Promise<void> {
    const containerName = this.getContainerName()
    console.warn(`Force-deleting Apple container ${containerName} (stop and kill both timed out)`)
    try {
      await execWithPath(`${this.getRunnerShellCommand()} delete --force ${containerName}`, { timeoutMs: 10_000 })
    } catch {
      console.error('Apple container force-delete failed')
    }
  }

  /**
   * Apple Container uses `container image list --format json` + `container image delete`.
   * Prefer `displayReference` (Apple 1.x); fall back to repository:tag.
   */
  static async removeOldImages(cliCommand: string, registry: string, currentTag: string): Promise<void> {
    try {
      const { stdout } = await execWithPath(`${cliCommand} image list --format json`)
      const images = JSON.parse(stdout)
      if (!Array.isArray(images)) return

      const currentImage = `${registry}:${currentTag}`
      const imagesToRemove = images
        .map((img: any) =>
          typeof img.displayReference === 'string'
            ? img.displayReference
            : img.repository && img.tag
              ? `${img.repository}:${img.tag}`
              : null,
        )
        .filter((ref: string | null): ref is string =>
          !!ref && ref !== currentImage && ref.startsWith(registry + ':'),
        )

      if (imagesToRemove.length === 0) return

      console.log(`[ContainerManager] Removing ${imagesToRemove.length} old image(s):`, imagesToRemove)
      for (const img of imagesToRemove) {
        try {
          await execWithPath(`${cliCommand} image delete ${shellEscape(img)}`)
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
   * Apple has no `rmi`. The failed run can leave a container record referencing
   * the image; 1.1.0 deletes referenced images anyway (live-verified), but clear
   * the record first so recovery never depends on that. `--force` only quiets
   * image-not-found, keeping the delete idempotent.
   */
  protected async removeCorruptImage(image: string): Promise<void> {
    await execWithPath(`${this.getRunnerShellCommand()} delete --force ${this.getContainerName()}`, { timeoutMs: 10_000 }).catch(() => {})
    await execWithPath(`${this.getRunnerShellCommand()} image delete --force ${shellEscape(image)}`)
  }

  /**
   * Check if a supported Apple Container CLI is installed. An unsupported
   * version reports not-installed so the UI offers Install, which upgrades
   * in place via the pinned pkg.
   */
  static async isAvailable(): Promise<boolean> {
    return (await getInstalledCliState()) === 'supported'
  }

  /**
   * Check if the Apple Container services are running and usable.
   *
   * Does NOT trust `system status` alone: a wedged daemon can pass the status
   * check while hanging every real request, and this probe backs
   * isRuntimeReachable() on the start path — so `list` proves the API actually
   * answers. Both hard-bounded so a hung daemon can't dangle the caller.
   */
  static async isRunning(): Promise<boolean> {
    try {
      await execWithPath('container system status', { timeoutMs: 10_000 })
      await execWithPath('container list', { timeoutMs: 10_000 })
      return true
    } catch {
      return false
    }
  }
}

function reportProgress(
  onProgress: ((progress: AppleContainerProvisionProgress) => void) | undefined,
  status: string,
  percent: number | null,
): void {
  onProgress?.({ status, percent })
}

async function installAppleContainerPkg(
  onProgress?: (progress: AppleContainerProvisionProgress) => void,
): Promise<void> {
  const url =
    `https://github.com/apple/container/releases/download/${APPLE_CONTAINER_VERSION}` +
    `/container-${APPLE_CONTAINER_VERSION}-installer-signed.pkg`
  const tmpDir = await mkdtemp(join(tmpdir(), 'superagent-apple-container-'))
  const pkgPath = join(tmpDir, `container-${APPLE_CONTAINER_VERSION}-installer-signed.pkg`)

  try {
    console.log(`[AppleContainer] Downloading signed installer ${APPLE_CONTAINER_VERSION}...`)
    reportProgress(onProgress, 'Downloading macOS Container installer...', 0)
    let lastPercent = -1
    let reportedIndeterminate = false
    await appleContainerProvisionIO.downloadToFile(url, pkgPath, (downloaded, total) => {
      if (total == null) {
        if (!reportedIndeterminate) {
          reportedIndeterminate = true
          reportProgress(onProgress, 'Downloading macOS Container installer...', null)
        }
        return
      }
      const percent = Math.min(100, Math.floor((downloaded / total) * 100))
      if (percent === lastPercent) return
      lastPercent = percent
      reportProgress(onProgress, 'Downloading macOS Container installer...', percent)
    })

    reportProgress(onProgress, 'Verifying installer...', null)
    const actualSha = await appleContainerProvisionIO.hashFileSha256(pkgPath)
    if (actualSha.toLowerCase() !== APPLE_CONTAINER_PKG_SHA256.toLowerCase()) {
      throw new Error(
        'Downloaded Apple Container installer failed integrity check. The file was discarded; try again.',
      )
    }

    // Elevate: copy + re-hash under root before installer (closes same-UID TOCTOU).
    reportProgress(onProgress, 'Installing - enter your password if prompted...', null)
    const elevateScript = [
      'set -e',
      `SRC=${shellEscape(pkgPath)}`,
      `EXPECTED=${shellEscape(APPLE_CONTAINER_PKG_SHA256)}`,
      'DIR=$(/usr/bin/mktemp -d /tmp/superagent-container-XXXXXX)',
      'trap \'/bin/rm -rf "$DIR"\' EXIT',
      'TMP="$DIR/installer.pkg"',
      '/bin/cp "$SRC" "$TMP"',
      '/bin/chmod 400 "$TMP"',
      'ACTUAL=$(/usr/bin/shasum -a 256 "$TMP" | /usr/bin/awk \'{print $1}\')',
      '[ "$ACTUAL" = "$EXPECTED" ]',
      '/usr/sbin/installer -pkg "$TMP" -target /',
    ].join('\n')
    try {
      await runWithAdminPrivileges(elevateScript)
    } catch (error) {
      if (isAdminPrivilegeCancelError(error)) {
        throw new Error(
          'Administrator password prompt was cancelled. macOS Container was not installed.',
        )
      }
      const message = error instanceof Error ? error.message : String(error)
      captureException(error, {
        tags: { component: 'apple-container', operation: 'install' },
        extra: await collectAppleContainerDiagnostics(),
      })
      throw new Error(`Failed to install Apple Container: ${message}`)
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function ensureAppleContainerReadyImpl(
  onProgress: ((progress: AppleContainerProvisionProgress) => void) | undefined,
  allowInstall: boolean,
): Promise<void> {
  if (!AppleContainerClient.isEligible()) {
    throw new Error('macOS Container requires macOS 26 or later on Apple silicon.')
  }

  const cliState = await getInstalledCliState()
  if (cliState !== 'supported') {
    if (!allowInstall) {
      throw new Error(
        cliState === 'absent'
          ? 'macOS Container is not installed. Click Install to set it up.'
          : `The installed macOS Container version is not supported. Click Install to update it to ${APPLE_CONTAINER_VERSION}.`,
      )
    }
    await installAppleContainerPkg(onProgress)
  }

  reportProgress(onProgress, 'Starting macOS Container...', null)
  try {
    await execWithPath(APPLE_SYSTEM_START_CMD, { timeoutMs: APPLE_SYSTEM_START_EXEC_TIMEOUT_MS })
  } catch (error: any) {
    if (!error?.message?.includes('already running')) {
      captureException(error, {
        tags: { component: 'apple-container', operation: 'system-start' },
        extra: await collectAppleContainerDiagnostics(),
      })
      throw new Error(
        `Failed to start Apple Container runtime: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const running = await AppleContainerClient.isRunning()
  if (!running) {
    const notReady = new Error('Apple Container runtime did not become ready after start.')
    captureException(notReady, {
      tags: { component: 'apple-container', operation: 'system-start' },
      extra: await collectAppleContainerDiagnostics(),
    })
    throw notReady
  }
}

/** Install (if allowInstall) + start. Serialized; install-capable calls don't join non-install. */
export async function ensureAppleContainerReady(
  onProgress?: (progress: AppleContainerProvisionProgress) => void,
  options?: { allowInstall?: boolean },
): Promise<void> {
  const allowInstall = options?.allowInstall === true
  if (appleReadyPromise && (appleReadyAllowsInstall || !allowInstall)) {
    return appleReadyPromise
  }
  if (appleReadyPromise) {
    try {
      await appleReadyPromise
    } catch {
      // Prior non-install failed; start our own.
    }
  }
  appleReadyAllowsInstall = allowInstall
  appleReadyPromise = ensureAppleContainerReadyImpl(onProgress, allowInstall)
  try {
    await appleReadyPromise
  } finally {
    appleReadyPromise = null
    appleReadyAllowsInstall = false
  }
}

/** Bound stop for restart/shutdown — CLI has no native stop timeout. */
export async function stopAppleContainerRuntime(): Promise<void> {
  await execWithPath('container system stop', { timeoutMs: APPLE_SYSTEM_STOP_EXEC_TIMEOUT_MS })
}

export function resetAppleContainerClientForTests(): void {
  cachedMacOSMajorVersion = undefined
  cachedGatewayIp = null
  appleReadyPromise = null
  appleReadyAllowsInstall = false
  appleContainerProvisionIO.downloadToFile = downloadToFile
  appleContainerProvisionIO.hashFileSha256 = hashFileSha256
}
