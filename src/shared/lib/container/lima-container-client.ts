import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { BaseContainerClient, checkCommandAvailable, execWithPath, writeEnvFile } from './base-container-client'
import { getEffectiveAnthropicApiKey, getSettings } from '@shared/lib/config/settings'
import { DEFAULT_LIMA_VM_MEMORY } from './types'
import type { ContainerConfig } from './types'
import { getDataDir } from '@shared/lib/config/data-dir'

export const LIMA_VM_NAME = 'superagent'

/** Cached macOS major version */
let cachedMacOSVersion: number | null | undefined = undefined

function getMacOSMajorVersion(): number | null {
  if (cachedMacOSVersion !== undefined) return cachedMacOSVersion
  if (process.platform !== 'darwin') {
    cachedMacOSVersion = null
    return null
  }
  try {
    const output = execSync('sw_vers -productVersion', { timeout: 5000 }).toString().trim()
    cachedMacOSVersion = parseInt(output.split('.')[0], 10)
    return cachedMacOSVersion
  } catch {
    cachedMacOSVersion = null
    return null
  }
}

/**
 * Get the directory where Lima stores VM data.
 * Uses a subdirectory of the app data dir.
 */
export function getLimaHome(): string {
  return path.join(getDataDir(), 'lima')
}

/**
 * Get the path to the nerdctl wrapper script.
 * This shell script delegates to `limactl shell <vm> -- nerdctl`
 * and works as both an exec command string and a spawn binary.
 */
export function getNerdctlWrapperPath(): string {
  // Use a path without spaces — the wrapper path is interpolated into shell
  // command strings by BaseContainerClient, so spaces would break parsing.
  // Also used as a spawn() binary, so must be a valid unquoted path.
  const home = process.env.HOME
  if (!home) {
    throw new Error('HOME environment variable is not set — cannot determine Lima nerdctl wrapper path')
  }
  return path.join(home, '.superagent', 'bin', 'lima-nerdctl')
}

/**
 * Get the limactl binary path.
 * Checks bundled location (Electron resources) first, then system PATH.
 */
export function getLimactlPath(): string {
  if (typeof process !== 'undefined' && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'lima', 'bin', 'limactl')
    if (fs.existsSync(bundled)) {
      return bundled
    }
  }
  return 'limactl'
}

/**
 * Run a limactl command with LIMA_HOME set.
 * Uses shell env var prefix so it works with execWithPath.
 */
function execLimactl(args: string): Promise<{ stdout: string; stderr: string }> {
  const limaHome = getLimaHome()
  const limactl = getLimactlPath()
  return execWithPath(`LIMA_HOME="${limaHome}" "${limactl}" ${args}`)
}

/**
 * Parse Lima's NDJSON list output into an array of VM objects.
 */
function parseLimaList(stdout: string): any[] {
  return stdout.trim().split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

/**
 * Lima + nerdctl implementation of ContainerClient.
 * Uses a Lima VM with Apple's Virtualization.framework to run containers
 * via nerdctl (Docker-compatible CLI for containerd).
 *
 * This is the bundled container runtime for macOS users who don't have
 * Docker Desktop or Podman installed.
 */
export class LimaContainerClient extends BaseContainerClient {
  static readonly runnerName = 'lima'

  constructor(config: ContainerConfig) {
    super(config)
  }

  /**
   * Lima is only eligible on macOS 13+ (requires Virtualization.framework).
   */
  static isEligible(): boolean {
    const version = getMacOSMajorVersion()
    return version !== null && version >= 13
  }

  /**
   * The runner command is a wrapper script that delegates to nerdctl
   * inside the Lima VM. This works for both exec() and spawn() calls.
   */
  protected getRunnerCommand(): string {
    return getNerdctlWrapperPath()
  }

  /**
   * Add --add-host so containers can reach the macOS host via host.docker.internal.
   * Lima/nerdctl doesn't set this up automatically like Docker Desktop does.
   * The host IP is the VM's default gateway (VZ NAT routes to the macOS host).
   */
  protected getAdditionalRunFlags(): string {
    try {
      const limaHome = getLimaHome()
      const limactl = getLimactlPath()
      const output = execSync(
        `LIMA_HOME="${limaHome}" "${limactl}" shell ${LIMA_VM_NAME} -- ip route show default`,
        { timeout: 10000 }
      ).toString().trim()
      // Output: "default via 192.168.64.1 dev enp0s1 ..."
      const match = output.match(/via\s+([\d.]+)/)
      if (match) {
        console.log(`Lima host IP detected: ${match[1]}`)
        return `--add-host host.docker.internal:${match[1]}`
      }
    } catch (e) {
      console.warn('Failed to detect host IP for Lima VM:', e)
    }
    return ''
  }

  /**
   * Override to write env files under ~ instead of /tmp.
   * Lima only mounts the home directory into the VM, so /var/folders/...
   * (macOS temp dir) is not accessible inside the VM.
   */
  protected buildEnvFile(additionalEnvVars?: Record<string, string>): { flag: string; cleanup: () => void } {
    const envVars: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: getEffectiveAnthropicApiKey(),
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      ...this.config.envVars,
      ...additionalEnvVars,
    }
    const home = process.env.HOME
    if (!home) {
      throw new Error('HOME environment variable is not set — cannot write container env file')
    }
    const tmpDir = path.join(home, '.superagent', 'tmp')
    return writeEnvFile(envVars, this.config.agentId, tmpDir)
  }

  /**
   * Handle run errors by provisioning the Lima VM if needed.
   */
  protected async handleRunError(error: any): Promise<boolean> {
    const msg = error.message || error.stderr || String(error)
    if (
      msg.includes('ENOENT') ||
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('not running') ||
      msg.includes('No such file') ||
      msg.includes('EACCES')
    ) {
      console.log('Lima VM not ready, attempting to provision...')
      try {
        await ensureLimaReady()
        return true
      } catch (err) {
        console.error('Failed to provision Lima VM:', err)
        return false
      }
    }
    return false
  }

  /**
   * nerdctl stats output matches Docker format.
   * No override needed — base class implementation works.
   */

  /**
   * Check if limactl is available (bundled or system-installed).
   */
  static async isAvailable(): Promise<boolean> {
    if (typeof process !== 'undefined' && process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'lima', 'bin', 'limactl')
      if (fs.existsSync(bundled)) return true
    }
    return checkCommandAvailable('limactl')
  }

  /**
   * Check if the Lima VM named 'superagent' is running.
   */
  static async isRunning(): Promise<boolean> {
    try {
      const { stdout } = await execLimactl(`list --json`)
      const vms = parseLimaList(stdout)
      return vms.some((vm: any) => vm.name === LIMA_VM_NAME && vm.status === 'Running')
    } catch {
      return false
    }
  }
}

/** Mutex: if ensureLimaReady is already in progress, concurrent callers await the same promise. */
let limaReadyPromise: Promise<void> | null = null

/**
 * Ensure the Lima VM is created, running, and the nerdctl wrapper script exists.
 * Called by startRunner('lima') in client-factory.ts and by handleRunError().
 * Serialized: concurrent calls share the same in-flight promise.
 */
export async function ensureLimaReady(): Promise<void> {
  if (limaReadyPromise) {
    return limaReadyPromise
  }
  limaReadyPromise = ensureLimaReadyImpl()
  try {
    await limaReadyPromise
  } finally {
    limaReadyPromise = null
  }
}

async function ensureLimaReadyImpl(): Promise<void> {
  const limaHome = getLimaHome()
  fs.mkdirSync(limaHome, { recursive: true })

  const settings = getSettings()
  const explicitMemory = settings.container.runtimeSettings?.lima?.vmMemory

  // Check if VM exists and whether its config matches
  let vmExists = false
  let vmMemory: string | null = null
  try {
    const { stdout } = await execLimactl('list --json')
    const vms = parseLimaList(stdout)
    const vm = vms.find((vm: any) => vm.name === LIMA_VM_NAME)
    if (vm) {
      vmExists = true
      vmMemory = vm.memory ? `${Math.round(vm.memory / (1024 * 1024 * 1024))}GiB` : null
    }
  } catch {
    // limactl not working or no VMs
  }

  // Recreate VM only if the user has explicitly set a memory preference and it differs
  if (vmExists && explicitMemory && vmMemory && vmMemory !== explicitMemory) {
    console.log(`Lima VM memory mismatch (current: ${vmMemory}, desired: ${explicitMemory}), recreating...`)
    try {
      await execLimactl(`stop ${LIMA_VM_NAME} --force`)
    } catch { /* may not be running */ }
    await execLimactl(`delete ${LIMA_VM_NAME} --force`)
    vmExists = false
  }

  if (!vmExists) {
    console.log('Creating Lima VM for Superagent...')
    await createLimaVm()
  }

  // Check if VM is running
  let vmRunning = false
  try {
    const { stdout } = await execLimactl('list --json')
    const vms = parseLimaList(stdout)
    vmRunning = vms.some((vm: any) => vm.name === LIMA_VM_NAME && vm.status === 'Running')
  } catch {
    // assume not running
  }

  if (!vmRunning) {
    console.log('Starting Lima VM...')
    try {
      await execLimactl(`start ${LIMA_VM_NAME}`)
    } catch (error) {
      // If start fails on a freshly created VM, delete it to avoid a zombie
      if (!vmExists) {
        console.error('Lima VM start failed after creation, cleaning up zombie VM...')
        try {
          await execLimactl(`delete ${LIMA_VM_NAME} --force`)
        } catch { /* best-effort cleanup */ }
      }
      throw error
    }
  }

  // Create/update the nerdctl wrapper script
  createNerdctlWrapper()
}

/**
 * Stop the Lima VM gracefully with a timeout.
 * Used during app shutdown — must not hang indefinitely.
 */
export async function stopLimaVm(timeoutMs = 15000): Promise<void> {
  try {
    await Promise.race([
      execLimactl(`stop ${LIMA_VM_NAME}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Lima VM stop timed out')), timeoutMs)
      ),
    ])
  } catch {
    // VM might not be running, or timed out — either way, continue
  }
}

/**
 * Create the Lima VM with VZ framework and VirtioFS.
 */
function getBundledVmImagePath(): string | null {
  if (typeof process !== 'undefined' && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'lima', 'vm-image.qcow2')
    if (fs.existsSync(bundled)) {
      return bundled
    }
  }
  return null
}

async function createLimaVm(): Promise<void> {
  const settings = getSettings()
  const vmMemory = settings.container.runtimeSettings?.lima?.vmMemory || DEFAULT_LIMA_VM_MEMORY

  const lines = [
    '# Lima VM for Superagent container runtime',
    'vmType: vz',
    'mountType: virtiofs',
    'mounts:',
    '  - location: "~"',
    '    writable: true',
    'cpus: 4',
    `memory: ${vmMemory}`,
    'disk: 60GiB',
    '',
    '# Alpine uses OpenRC, not systemd — disable Lima built-in containerd management',
    '# containerd + nerdctl are pre-baked into the VM image at build time',
    'containerd:',
    '  system: false',
    '  user: false',
    '',
    '# Start containerd via OpenRC on boot',
    'provision:',
    '  - mode: system',
    '    script: |',
    '      #!/bin/sh',
    '      service containerd start || true',
  ]

  // Use bundled VM image if available (avoids downloading from the internet)
  const bundledImage = getBundledVmImagePath()
  if (bundledImage) {
    const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
    lines.push(
      'images:',
      `  - location: "file://${bundledImage}"`,
      `    arch: "${arch}"`,
    )
    console.log(`Using bundled VM image: ${bundledImage}`)
  }

  lines.push('')
  const config = lines.join('\n')

  const configPath = path.join(getLimaHome(), `vm-config-${Date.now()}.yaml`)
  fs.writeFileSync(configPath, config)

  try {
    await execLimactl(`create --name ${LIMA_VM_NAME} "${configPath}" --tty=false`)
  } finally {
    try { fs.unlinkSync(configPath) } catch { /* ignore */ }
  }
}

/**
 * Create the nerdctl wrapper shell script.
 * The script sets LIMA_HOME and delegates to limactl shell → nerdctl.
 * This works as both a command string (for exec) and a binary (for spawn).
 */
function createNerdctlWrapper(): void {
  const wrapperPath = getNerdctlWrapperPath()
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true })

  const limactlPath = getLimactlPath()
  const limaHome = getLimaHome()

  const script = [
    '#!/bin/sh',
    `export LIMA_HOME="${limaHome}"`,
    `exec "${limactlPath}" shell ${LIMA_VM_NAME} -- sudo nerdctl "$@"`,
    '',
  ].join('\n')

  fs.writeFileSync(wrapperPath, script, { mode: 0o755 })
}
