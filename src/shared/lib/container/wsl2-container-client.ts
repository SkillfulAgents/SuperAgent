import { execSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BaseContainerClient, checkCommandAvailable, execWithPath, writeEnvFile } from './base-container-client'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import type { ContainerConfig } from './types'
import { getDataDir } from '@shared/lib/config/data-dir'
import { captureException, captureMessage, addErrorBreadcrumb } from '@shared/lib/error-reporting'

/**
 * Collect diagnostic data about the WSL2 environment at the moment of failure.
 */
function collectWSL2Diagnostics(): Record<string, unknown> {
  const diag: Record<string, unknown> = {}
  const wsl2Home = getWSL2Home()

  try {
    // WSL version and status
    try {
      diag.wsl_version = execSync('wsl --version 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim().replace(/\0/g, '')
    } catch { diag.wsl_version = 'check_failed' }

    try {
      diag.wsl_status = execSync('wsl --status 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim().replace(/\0/g, '')
    } catch { diag.wsl_status = 'check_failed' }

    // All distros and their states
    try {
      const raw = execSync('wsl --list --verbose 2>&1', { encoding: 'utf-8', timeout: 5000 }).replace(/\0/g, '')
      const distros = parseWSLList(raw)
      diag.all_distros = distros
      const ours = distros.find(d => d.name === WSL2_DISTRO_NAME)
      diag.our_distro_state = ours?.state ?? 'not_found'
      diag.our_distro_wsl_version = ours?.version ?? 'N/A'
    } catch { diag.all_distros = 'check_failed' }

    // WSL2 home directory state
    try {
      diag.wsl2_home_exists = fs.existsSync(wsl2Home)
      if (diag.wsl2_home_exists) {
        const distroDir = path.join(wsl2Home, 'distro')
        diag.distro_dir_exists = fs.existsSync(distroDir)
        if (diag.distro_dir_exists) {
          const entries = fs.readdirSync(distroDir)
          diag.distro_dir_contents = entries
          // Check vhdx size (the virtual disk)
          const vhdx = entries.find(e => e.endsWith('.vhdx'))
          if (vhdx) {
            const stat = fs.statSync(path.join(distroDir, vhdx))
            diag.vhdx_size_mb = Math.round(stat.size / 1048576)
          }
        }
      }
    } catch { /* ignore */ }

    // Bundled rootfs availability
    try {
      if (process.resourcesPath) {
        const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64'
        const rootfsPath = path.join(process.resourcesPath, 'wsl2', `alpine-rootfs-${arch}.tar.gz`)
        diag.bundled_rootfs_exists = fs.existsSync(rootfsPath)
        diag.bundled_rootfs_arch = arch
        if (diag.bundled_rootfs_exists) {
          diag.bundled_rootfs_size_mb = Math.round(fs.statSync(rootfsPath).size / 1048576)
        }
      }
    } catch { /* ignore */ }

    // Nerdctl wrapper state
    try {
      const wrapperPath = getWSL2NerdctlWrapperPath()
      diag.nerdctl_wrapper_exists = fs.existsSync(wrapperPath)
    } catch { /* ignore */ }

    // Disk space on distro volume
    try {
      const drive = wsl2Home.substring(0, 2)
      const wmicOut = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace,Size /format:csv 2>nul`, { encoding: 'utf-8', timeout: 5000 })
      const lines = wmicOut.split('\n').filter(Boolean)
      const last = lines[lines.length - 1]?.split(',')
      if (last && last.length >= 3) {
        diag.disk_free_gb = Math.round(parseInt(last[1], 10) / 1073741824)
        diag.disk_total_gb = Math.round(parseInt(last[2], 10) / 1073741824)
      }
    } catch { /* ignore */ }

    // Windows build (WSL2 behavior varies significantly by build)
    try {
      diag.windows_build = execSync('cmd /c ver 2>nul', { encoding: 'utf-8', timeout: 3000 }).trim()
    } catch { /* ignore */ }

    // System memory
    diag.system_memory_free_mb = Math.round(os.freemem() / 1048576)
    diag.system_memory_total_mb = Math.round(os.totalmem() / 1048576)
    diag.system_arch = os.arch()

  } catch {
    diag.diagnostic_error = 'failed to collect diagnostics'
  }

  return diag
}

export const WSL2_DISTRO_NAME = 'superagent'

/**
 * Convert a Windows path to a WSL2 path.
 * E.g., C:\Users\foo\bar → /mnt/c/Users/foo/bar
 *       C:/Users/foo/bar → /mnt/c/Users/foo/bar
 */
export function windowsToWSLPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/')
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`
  }
  return normalized
}

/**
 * Get the directory where WSL2 distro data is stored.
 */
export function getWSL2Home(): string {
  return path.join(getDataDir(), 'wsl2')
}

/**
 * Get the path to the nerdctl wrapper batch script.
 * This .cmd script delegates to `wsl -d superagent -- nerdctl`.
 */
export function getWSL2NerdctlWrapperPath(): string {
  const home = os.homedir()
  return path.join(home, '.superagent', 'bin', 'wsl-nerdctl.cmd')
}

/**
 * Run a WSL command targeting the superagent distro.
 * `args` is a shell command string executed inside the distro.
 */
function execWSL(args: string): Promise<{ stdout: string; stderr: string }> {
  return execWithPath(`wsl -d ${WSL2_DISTRO_NAME} -- ${args}`)
}

/**
 * Parse wsl --list --verbose output into distro status objects.
 * WSL outputs UTF-16LE on Windows, so we strip null bytes.
 */
function parseWSLList(stdout: string): { name: string; state: string; version: string }[] {
  // Strip null bytes from UTF-16LE encoding
  const clean = stdout.replace(/\0/g, '')
  const lines = clean.trim().split('\n').map(l => l.trim()).filter(Boolean)

  // First line is a header: "  NAME    STATE   VERSION"
  // Skip it
  const results: { name: string; state: string; version: string }[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // Remove leading * (default distro marker)
    const cleaned = line.replace(/^\*\s*/, '')
    const parts = cleaned.split(/\s+/)
    if (parts.length >= 3) {
      results.push({
        name: parts[0],
        state: parts[1],
        version: parts[2],
      })
    }
  }
  return results
}

/**
 * WSL2 + nerdctl implementation of ContainerClient.
 * Uses a WSL2 distro with Alpine Linux to run containers via nerdctl
 * (Docker-compatible CLI for containerd).
 *
 * This is the bundled container runtime for Windows users who don't have
 * Docker Desktop or Podman installed.
 */
export class WSL2ContainerClient extends BaseContainerClient {
  static readonly runnerName = 'wsl2'

  constructor(config: ContainerConfig) {
    super(config)
  }

  /**
   * WSL2 is only eligible on Windows.
   */
  static isEligible(): boolean {
    return process.platform === 'win32'
  }

  /**
   * The runner command is a wrapper .cmd script that delegates to nerdctl
   * inside the WSL2 distro.
   */
  protected getRunnerCommand(): string {
    return getWSL2NerdctlWrapperPath()
  }

  /**
   * Add --add-host so containers can reach the Windows host via host.docker.internal.
   * We detect the Windows host IP from inside the WSL2 distro using its default gateway,
   * similar to how Lima detects the macOS host IP.
   *
   * nerdctl's `host-gateway` resolves to the container bridge gateway (inside WSL2),
   * NOT the Windows host, so we must resolve the actual IP.
   */
  protected getAdditionalRunFlags(): string {
    try {
      const output = execSync(
        `wsl -d ${WSL2_DISTRO_NAME} -- ip route show default`,
        { timeout: 10000 }
      ).toString().trim()
      // Output: "default via 172.22.192.1 dev eth0 ..."
      const match = output.match(/via\s+([\d.]+)/)
      if (match) {
        console.log(`WSL2 host IP detected: ${match[1]}`)
        return `--add-host host.docker.internal:${match[1]}`
      }
    } catch (e) {
      console.warn('Failed to detect host IP for WSL2 distro:', e)
    }
    // Fallback: host-gateway may still work in some configurations
    return '--add-host host.docker.internal:host-gateway'
  }

  /**
   * Translate Windows host paths to WSL2 paths for volume mounts and env files.
   */
  protected hostPathForRuntime(hostPath: string): string {
    return windowsToWSLPath(hostPath)
  }

  /**
   * Override to write env files under %USERPROFILE%\.superagent\tmp\ and
   * translate the path for WSL2.
   */
  protected buildEnvFile(additionalEnvVars?: Record<string, string>): { flag: string; cleanup: () => void } {
    const envVars: Record<string, string | undefined> = {
      ...getActiveLlmProvider().getContainerEnvVars(),
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      ...this.config.envVars,
      ...additionalEnvVars,
    }

    const home = os.homedir()
    const tmpDir = path.join(home, '.superagent', 'tmp')
    const { filePath, cleanup } = writeEnvFile(envVars, this.config.agentId, tmpDir)

    // Translate the Windows file path to a WSL2 path for the --env-file flag
    const wslPath = windowsToWSLPath(filePath)
    return { flag: `--env-file "${wslPath}"`, cleanup }
  }

  /**
   * Handle run errors by provisioning the WSL2 distro if needed.
   */
  protected async handleRunError(error: any): Promise<boolean> {
    const msg = error.message || error.stderr || String(error)
    addErrorBreadcrumb({ category: 'wsl2', message: 'Container run error', data: { error: msg, agentId: this.config.agentId } })
    if (
      msg.includes('ENOENT') ||
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('not running') ||
      msg.includes('No such file') ||
      msg.includes('EACCES') ||
      msg.includes('is not recognized')
    ) {
      console.log('WSL2 distro not ready, attempting to provision...')
      try {
        await ensureWSL2Ready()
        return true
      } catch (err) {
        captureException(err, {
          tags: { component: 'wsl2', operation: 'provision' },
          extra: { originalError: msg, agentId: this.config.agentId, ...collectWSL2Diagnostics() },
        })
        console.error('Failed to provision WSL2 distro:', err)
        return false
      }
    }
    captureException(error, {
      tags: { component: 'wsl2', operation: 'container-run' },
      extra: { agentId: this.config.agentId, ...collectWSL2Diagnostics() },
    })
    return false
  }

  /**
   * Force-stop by terminating the WSL2 distro directly.
   * Called when nerdctl stop + kill both time out because the distro is unresponsive.
   */
  protected async forceStop(): Promise<void> {
    console.warn('Force-terminating WSL2 distro')
    try {
      await Promise.race([
        execWithPath(`wsl --terminate ${WSL2_DISTRO_NAME}`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('WSL2 terminate timed out')), 10000)
        ),
      ])
    } catch {
      console.error('WSL2 distro terminate failed')
    }
  }

  /**
   * Check if WSL2 is available (wsl.exe exists and WSL2 is enabled).
   */
  static async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      // Check if wsl.exe exists and can list distros
      await execWithPath('wsl --status')
      return true
    } catch {
      // Fallback: try just checking if wsl.exe is on PATH
      return checkCommandAvailable('wsl')
    }
  }

  /**
   * Check if the WSL2 distro named 'superagent' is running and nerdctl is usable.
   */
  static async isRunning(): Promise<boolean> {
    try {
      const { stdout } = await execWithPath('wsl --list --verbose')
      const distros = parseWSLList(stdout)
      const distro = distros.find(d => d.name === WSL2_DISTRO_NAME)
      if (!distro || distro.state !== 'Running') {
        return false
      }

      // Verify nerdctl and containerd are working inside the distro
      await execWSL('/usr/local/bin/superagent-nerdctl version')

      // Ensure the wrapper script points to the current configuration
      createWSL2NerdctlWrapper()
      return true
    } catch {
      // Expected on startup before containerd is ready — ensureWSL2Ready will handle it
      return false
    }
  }
}

/** Mutex: if ensureWSL2Ready is already in progress, concurrent callers await the same promise. */
let wsl2ReadyPromise: Promise<void> | null = null

/**
 * Ensure the WSL2 distro is imported, running, provisioned, and the wrapper script exists.
 * Called by startRunner('wsl2') in client-factory.ts and by handleRunError().
 * Serialized: concurrent calls share the same in-flight promise.
 */
export async function ensureWSL2Ready(): Promise<void> {
  if (wsl2ReadyPromise) {
    return wsl2ReadyPromise
  }
  wsl2ReadyPromise = ensureWSL2ReadyImpl(false)
  try {
    await wsl2ReadyPromise
  } finally {
    wsl2ReadyPromise = null
  }
}

async function ensureWSL2ReadyImpl(isRetry: boolean): Promise<void> {
  const wsl2Home = getWSL2Home()
  fs.mkdirSync(wsl2Home, { recursive: true })

  addErrorBreadcrumb({ category: 'wsl2', message: 'ensureWSL2Ready started', data: { wsl2Home, isRetry } })

  // Check if distro exists
  let distroExists = false
  try {
    const { stdout } = await execWithPath('wsl --list --verbose')
    const distros = parseWSLList(stdout)
    distroExists = distros.some(d => d.name === WSL2_DISTRO_NAME)
  } catch {
    // WSL not working
  }

  if (!distroExists) {
    console.log('Creating WSL2 distro for Superagent...')
    addErrorBreadcrumb({ category: 'wsl2', message: 'Creating new WSL2 distro' })
    try {
      await createWSL2Distro()
    } catch (err) {
      captureException(err, {
        tags: { component: 'wsl2', operation: 'create-distro' },
        extra: { wsl2Home, ...collectWSL2Diagnostics() },
      })
      throw err
    }
  }

  // Check if distro is running
  let distroRunning = false
  try {
    const { stdout } = await execWithPath('wsl --list --verbose')
    const distros = parseWSLList(stdout)
    distroRunning = distros.some(d => d.name === WSL2_DISTRO_NAME && d.state === 'Running')
  } catch {
    // assume not running
  }

  if (!distroRunning) {
    console.log('Starting WSL2 distro...')
    addErrorBreadcrumb({ category: 'wsl2', message: 'Starting WSL2 distro' })
    try {
      // Running any command starts the distro
      await execWSL('echo starting')
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      // HCS_E_CONNECTION_TIMEOUT means the WSL VM is stuck — a full shutdown
      // of the WSL service usually fixes it.  Try once before giving up.
      if (!isRetry && errMsg.includes('HCS_E_CONNECTION_TIMEOUT')) {
        console.warn('WSL2 start timed out (HCS_E_CONNECTION_TIMEOUT), restarting WSL service and retrying...')
        addErrorBreadcrumb({ category: 'wsl2', message: 'HCS timeout, attempting wsl --shutdown + retry' })
        captureMessage('WSL2 HCS_E_CONNECTION_TIMEOUT — auto-recovering via wsl --shutdown', {
          level: 'warning',
          tags: { component: 'wsl2', operation: 'start-distro-hcs-timeout' },
          extra: { wsl2Home, distroExists, ...collectWSL2Diagnostics() },
        })
        try {
          await execWithPath('wsl --shutdown')
        } catch { /* best-effort */ }
        return ensureWSL2ReadyImpl(true)
      }
      captureException(error, {
        tags: { component: 'wsl2', operation: 'start-distro' },
        extra: { wsl2Home, distroExists, ...collectWSL2Diagnostics() },
      })
      // If start fails on a freshly created distro, unregister to avoid a zombie
      if (!distroExists) {
        console.error('WSL2 distro start failed after creation, cleaning up...')
        try {
          await execWithPath(`wsl --unregister ${WSL2_DISTRO_NAME}`)
        } catch { /* best-effort cleanup */ }
      }
      throw error
    }
  }

  // Check if the distro is properly provisioned (has the superagent-nerdctl helper).
  // An existing distro may be missing it if a previous provisioning failed partway
  // through, or if the app was upgraded from a version that didn't provision it.
  let isProvisioned = false
  try {
    await execWSL('test -x /usr/local/bin/superagent-nerdctl')
    isProvisioned = true
  } catch {
    // Helper script missing
  }

  if (!isProvisioned) {
    console.log('WSL2 distro exists but is not provisioned, re-provisioning...')
    try {
      await provisionWSL2Distro()
    } catch (error) {
      captureException(error, {
        tags: { component: 'wsl2', operation: 'provision' },
        extra: { wsl2Home, isRetry, ...collectWSL2Diagnostics() },
      })
      console.error('Re-provisioning failed, unregistering broken distro...')
      try {
        await execWithPath(`wsl --unregister ${WSL2_DISTRO_NAME}`)
      } catch { /* best-effort cleanup */ }
      throw new Error(
        `Failed to provision WSL2 distro: ${error instanceof Error ? error.message : String(error)}. ` +
        'The distro has been removed. It will be recreated on next attempt. ' +
        'If the problem persists, check your network connection (Alpine packages must be downloaded).'
      )
    }
  }

  // Use the helper script to ensure containerd is running and verify nerdctl works.
  // The superagent-nerdctl script starts containerd on-demand if not already running.
  let containerdReady = false
  console.log('Ensuring containerd is running...')
  try {
    await execWSL('/usr/local/bin/superagent-nerdctl version')
    containerdReady = true
  } catch {
    // Helper script might need a moment on first run; retry a few times
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        await execWSL('/usr/local/bin/superagent-nerdctl version')
        containerdReady = true
        break
      } catch {
        // keep trying
      }
    }
  }

  if (!containerdReady) {
    const containerdError = new Error(
      'containerd failed to start inside WSL2 distro. ' +
      'Try running "wsl --unregister superagent" in PowerShell and restarting the app.'
    )
    captureException(containerdError, {
      tags: { component: 'wsl2', operation: 'containerd-start' },
      extra: { wsl2Home, ...collectWSL2Diagnostics() },
    })
    throw containerdError
  }

  // Verify the distro can mount the Windows filesystem.
  // A broken distro (e.g., created with wrong architecture before ARM support)
  // may appear provisioned but fail to mount /mnt/c, which breaks volume mounts
  // and env-file access at container run time.
  let mountHealthy = false
  try {
    await execWSL('test -d /mnt/c/Windows')
    mountHealthy = true
  } catch {
    // /mnt/c not accessible
  }

  if (!mountHealthy) {
    if (isRetry) {
      const mountError = new Error(
        'WSL2 distro cannot mount the Windows filesystem (/mnt/c). ' +
        'Try running "wsl --unregister superagent" in PowerShell and restarting the app.'
      )
      captureException(mountError, {
        tags: { component: 'wsl2', operation: 'mount-check' },
        extra: { wsl2Home, isRetry: true, ...collectWSL2Diagnostics() },
      })
      throw mountError
    }
    console.warn('WSL2 distro has broken Windows filesystem mounts, recreating...')
    addErrorBreadcrumb({ category: 'wsl2', message: 'Broken mount detected, recreating distro', level: 'warning' })
    try {
      await execWithPath(`wsl --unregister ${WSL2_DISTRO_NAME}`)
    } catch { /* best-effort cleanup */ }
    return ensureWSL2ReadyImpl(true)
  }

  // Create/update the nerdctl wrapper script
  createWSL2NerdctlWrapper()
  addErrorBreadcrumb({ category: 'wsl2', message: 'ensureWSL2Ready completed successfully' })
}

/**
 * Stop the WSL2 distro gracefully.
 * Used during app shutdown.
 */
export async function stopWSL2Distro(timeoutMs = 15000): Promise<void> {
  try {
    await Promise.race([
      execWithPath(`wsl --terminate ${WSL2_DISTRO_NAME}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WSL2 distro stop timed out')), timeoutMs)
      ),
    ])
  } catch {
    // Distro might not be running, or timed out — either way, continue
  }
}

/**
 * Get the bundled Alpine minirootfs tarball path for the current architecture.
 * We bundle both x86_64 and aarch64 rootfs files and select at runtime
 * so a single installer works on both architectures.
 */
function getBundledRootfsPath(): string | null {
  if (typeof process !== 'undefined' && process.resourcesPath) {
    const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64'
    const bundled = path.join(process.resourcesPath, 'wsl2', `alpine-rootfs-${arch}.tar.gz`)
    if (fs.existsSync(bundled)) {
      return bundled
    }
  }
  return null
}

async function createWSL2Distro(): Promise<void> {
  const wsl2Home = getWSL2Home()
  const installDir = path.join(wsl2Home, 'distro')
  fs.mkdirSync(installDir, { recursive: true })

  // Get rootfs tarball
  const bundledRootfs = getBundledRootfsPath()
  if (!bundledRootfs) {
    throw new Error(
      'Bundled Alpine rootfs not found. The WSL2 runtime requires the Alpine rootfs to be ' +
      'bundled with the application. Please ensure the build includes the WSL2 resources.'
    )
  }

  console.log(`Importing WSL2 distro from: ${bundledRootfs}`)
  await execWithPath(`wsl --import ${WSL2_DISTRO_NAME} "${installDir}" "${bundledRootfs}"`)

  // Provision the distro; if provisioning fails, unregister to avoid a zombie distro
  try {
    await provisionWSL2Distro()
  } catch (error) {
    console.error('Provisioning failed after distro import, cleaning up...')
    try {
      await execWithPath(`wsl --unregister ${WSL2_DISTRO_NAME}`)
    } catch { /* best-effort cleanup */ }
    throw error
  }
}

/**
 * Provision the WSL2 distro: install containerd, nerdctl, buildkit, cni-plugins,
 * and create the superagent-nerdctl helper script.
 * Safe to call on an already-provisioned distro (idempotent).
 */
async function provisionWSL2Distro(): Promise<void> {
  console.log('Provisioning WSL2 distro...')
  const provisionScript = [
    '#!/bin/sh',
    'set -e',
    '',
    '# Fix DNS for Go-based tools (nerdctl/containerd). WSL2\'s DNS tunnel proxy',
    '# at 10.255.255.254 has a bug (microsoft/WSL#13415) where it mangles AAAA',
    '# queries by appending Windows search suffixes, causing Go\'s parallel',
    '# A+AAAA resolver to fail with "no such host". single-request forces',
    '# sequential queries to work around this. The 1.1.1.1 fallback catches',
    '# cases where the proxy fails entirely (e.g. firewall/antivirus).',
    'grep -q "single-request" /etc/resolv.conf 2>/dev/null || echo "options single-request" >> /etc/resolv.conf',
    'grep -q "1.1.1.1" /etc/resolv.conf 2>/dev/null || echo "nameserver 1.1.1.1" >> /etc/resolv.conf',
    '',
    '# Configure Alpine repositories',
    'cat > /etc/apk/repositories << "REPOS"',
    'https://dl-cdn.alpinelinux.org/alpine/v3.23/main',
    'https://dl-cdn.alpinelinux.org/alpine/v3.23/community',
    'REPOS',
    '',
    '# Install container runtime packages',
    'apk update',
    'apk add --no-cache containerd nerdctl buildkit cni-plugins',
    '',
    '# Create a helper script that ensures containerd is running before nerdctl.',
    '# The [boot] command in wsl.conf is unreliable across WSL versions,',
    '# so this script is the primary mechanism for starting containerd.',
    'cat > /usr/local/bin/superagent-nerdctl << "NERDCTL_WRAPPER"',
    '#!/bin/sh',
    '# Fix DNS for Go resolver (WSL regenerates resolv.conf on boot, so reapply)',
    'grep -q "single-request" /etc/resolv.conf 2>/dev/null || echo "options single-request" >> /etc/resolv.conf',
    'grep -q "1.1.1.1" /etc/resolv.conf 2>/dev/null || echo "nameserver 1.1.1.1" >> /etc/resolv.conf',
    'if ! pidof containerd > /dev/null 2>&1; then',
    '  # Use setsid to detach containerd from the shell session so it survives',
    '  # after the wsl -d ... command exits (busybox sh sends SIGHUP to bg jobs).',
    '  setsid containerd > /dev/null 2>&1 &',
    '  # Wait for socket',
    '  for i in $(seq 1 10); do',
    '    [ -S /run/containerd/containerd.sock ] && break',
    '    sleep 1',
    '  done',
    'fi',
    'exec nerdctl "$@"',
    'NERDCTL_WRAPPER',
    'chmod +x /usr/local/bin/superagent-nerdctl',
    '',
    '# Also try boot command as optimization (may not work on all WSL versions)',
    'cat > /etc/wsl.conf << "WSLCONF"',
    '[boot]',
    'command = /bin/sh -c "setsid containerd > /dev/null 2>&1 &"',
    'WSLCONF',
  ].join('\n')

  // Pipe the provision script via stdin rather than writing to a file on the
  // Windows filesystem. Freshly imported WSL2 distros may not have /mnt/c
  // automounted yet, making Windows file paths inaccessible.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('wsl', ['-d', WSL2_DISTRO_NAME, '--', 'sh', '-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Provision script failed (exit ${code}): ${stderr.trim()}`))
      }
    })
    proc.on('error', reject)
    proc.stdin.write(provisionScript)
    proc.stdin.end()
  })
}

/**
 * Create/update the nerdctl wrapper .cmd script.
 * The script delegates to `wsl -d superagent -- /usr/local/bin/superagent-nerdctl`.
 * This works as both a command string (for exec) and a binary (for spawn with shell:true).
 */
function createWSL2NerdctlWrapper(): void {
  const wrapperPath = getWSL2NerdctlWrapperPath()
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true })

  // Use the superagent-nerdctl helper inside WSL2 which ensures
  // containerd is running before executing nerdctl.
  const script = [
    '@echo off',
    `wsl -d ${WSL2_DISTRO_NAME} -- /usr/local/bin/superagent-nerdctl %*`,
    '',
  ].join('\r\n')

  fs.writeFileSync(wrapperPath, script)
}
