import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { BaseContainerClient, checkCommandAvailable, execWithPath, CONTAINER_INTERNAL_PORT, shellEscape } from './base-container-client'
import type { ContainerConfig, ContainerInfo, ContainerStats, ImagePullProgress } from './types'
import { isAdminPrivilegeCancelError, runWithAdminPrivileges } from '@shared/lib/run-with-admin-privileges'

export type AppleContainerProvisionProgress = Pick<ImagePullProgress, 'status' | 'percent'>

const APPLE_CONTAINER_VERSION = '1.1.0' // pin; do not follow releases/latest
export const APPLE_CONTAINER_PKG_SHA256 =
  '0ca1c42a2269c2557efb1d82b1b38ac553e6a3a3da1b1179c439bcee1e7d6714'
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

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
   * Handle kernel-not-configured error on first use by auto-installing the recommended kernel.
   */
  protected async handleRunError(error: any): Promise<boolean> {
    if (error.message?.includes('kernel not configured')) {
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
      console.log(`Apple Container kernel not configured for ${arch}, installing recommended kernel...`)
      await execWithPath(`container system kernel set --arch ${arch} --recommended`)
      return true
    }
    return false
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
   * Apple Container does not currently support `container stats`.
   */
  async getStats(): Promise<ContainerStats | null> {
    return null
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

  /** Apple has no `rmi`; corrupt-image recovery uses `image delete`. */
  protected async removeCorruptImage(image: string): Promise<void> {
    await execWithPath(`${this.getRunnerShellCommand()} image delete ${shellEscape(image)}`)
  }

  /**
   * Check if the Apple Container CLI is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    return checkCommandAvailable('container')
  }

  /**
   * Check if the Apple Container services are running and usable.
   */
  static async isRunning(): Promise<boolean> {
    try {
      await execWithPath('container system status')
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

  const installed = await AppleContainerClient.isAvailable()
  if (!installed) {
    if (!allowInstall) {
      throw new Error('macOS Container is not installed. Click Install to set it up.')
    }
    await installAppleContainerPkg(onProgress)
  }

  reportProgress(onProgress, 'Starting macOS Container...', null)
  try {
    await execWithPath('container system start --enable-kernel-install')
  } catch (error: any) {
    if (!error?.message?.includes('already running')) {
      throw new Error(
        `Failed to start Apple Container runtime: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const running = await AppleContainerClient.isRunning()
  if (!running) {
    throw new Error('Apple Container runtime did not become ready after start.')
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

export function resetAppleContainerClientForTests(): void {
  cachedMacOSMajorVersion = undefined
  appleReadyPromise = null
  appleReadyAllowsInstall = false
  appleContainerProvisionIO.downloadToFile = downloadToFile
  appleContainerProvisionIO.hashFileSha256 = hashFileSha256
}
