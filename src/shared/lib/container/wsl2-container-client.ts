import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BaseContainerClient, checkCommandAvailable, execWithPath, shellQuote, writeEnvFile } from './base-container-client'
import { getEffectiveAnthropicApiKey } from '@shared/lib/config/settings'
import type { ContainerConfig } from './types'
import { getDataDir } from '@shared/lib/config/data-dir'

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
  return execWithPath(`wsl -d ${shellQuote(WSL2_DISTRO_NAME)} -- ${args}`)
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
        `wsl -d ${shellQuote(WSL2_DISTRO_NAME)} -- ip route show default`,
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
      ANTHROPIC_API_KEY: getEffectiveAnthropicApiKey(),
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
        console.error('Failed to provision WSL2 distro:', err)
        return false
      }
    }
    return false
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
  wsl2ReadyPromise = ensureWSL2ReadyImpl()
  try {
    await wsl2ReadyPromise
  } finally {
    wsl2ReadyPromise = null
  }
}

async function ensureWSL2ReadyImpl(): Promise<void> {
  const wsl2Home = getWSL2Home()
  fs.mkdirSync(wsl2Home, { recursive: true })

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
    await createWSL2Distro()
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
    try {
      // Running any command starts the distro
      await execWSL('echo starting')
    } catch (error) {
      // If start fails on a freshly created distro, unregister to avoid a zombie
      if (!distroExists) {
        console.error('WSL2 distro start failed after creation, cleaning up...')
        try {
          await execWithPath(`wsl --unregister ${shellQuote(WSL2_DISTRO_NAME)}`)
        } catch { /* best-effort cleanup */ }
      }
      throw error
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
    throw new Error('containerd failed to start inside WSL2 distro')
  }

  // Create/update the nerdctl wrapper script
  createWSL2NerdctlWrapper()
}

/**
 * Stop the WSL2 distro gracefully.
 * Used during app shutdown.
 */
export async function stopWSL2Distro(timeoutMs = 15000): Promise<void> {
  try {
    await Promise.race([
      execWithPath(`wsl --terminate ${shellQuote(WSL2_DISTRO_NAME)}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WSL2 distro stop timed out')), timeoutMs)
      ),
    ])
  } catch {
    // Distro might not be running, or timed out — either way, continue
  }
}

/**
 * Get the bundled Alpine minirootfs tarball path if available.
 * Falls back to null (will need to download at runtime — not implemented yet).
 */
function getBundledRootfsPath(): string | null {
  if (typeof process !== 'undefined' && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'wsl2', 'alpine-rootfs.tar.gz')
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
  await execWithPath(`wsl --import ${shellQuote(WSL2_DISTRO_NAME)} "${installDir}" "${bundledRootfs}"`)

  // Provision the distro: install containerd, nerdctl, buildkit, cni-plugins
  console.log('Provisioning WSL2 distro...')
  const provisionScript = [
    '#!/bin/sh',
    'set -e',
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

  // Write provision script to a temp location accessible inside WSL2
  const tmpDir = path.join(os.homedir(), '.superagent', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const scriptPath = path.join(tmpDir, `provision-${Date.now()}.sh`)
  fs.writeFileSync(scriptPath, provisionScript, { mode: 0o755 })

  try {
    const wslScriptPath = windowsToWSLPath(scriptPath)
    await execWithPath(`wsl -d ${shellQuote(WSL2_DISTRO_NAME)} -- sh "${wslScriptPath}"`)
  } finally {
    try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }
  }
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
