import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { BaseContainerClient, checkCommandAvailable, execWithPath, writeEnvFile } from './base-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { DEFAULT_LIMA_VM_MEMORY } from './types'
import type { ContainerConfig } from './types'
import os from 'os'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'

/**
 * Collect diagnostic data about the Lima environment at the moment of failure.
 * Runs quick checks to surface the actual root cause of VM issues.
 */
function collectLimaDiagnostics(): Record<string, unknown> {
  const diag: Record<string, unknown> = {}
  const limaHome = getLimaHome()
  const limactlPath = getLimactlPath()

  try {
    // Is limactl actually accessible?
    diag.limactl_path = limactlPath
    diag.limactl_is_bundled = limactlPath !== 'limactl'
    try {
      fs.accessSync(limactlPath, fs.constants.X_OK)
      diag.limactl_executable = true
    } catch (e: any) {
      diag.limactl_executable = false
      diag.limactl_access_error = e.code
    }

    // limactl version
    try {
      diag.limactl_version = execSync(`LIMA_HOME="${limaHome}" "${limactlPath}" --version 2>&1`, { encoding: 'utf-8', timeout: 5000 }).toString().trim()
    } catch { diag.limactl_version = 'check_failed' }

    // VM state from limactl list
    try {
      const raw = execSync(`LIMA_HOME="${limaHome}" "${limactlPath}" list --json 2>&1`, { encoding: 'utf-8', timeout: 10000 }).trim()
      const vms = raw.split('\n').filter(Boolean).map((l: string) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const vm = vms.find((v: any) => v.name === LIMA_VM_NAME)
      if (vm) {
        diag.vm_status = vm.status
        diag.vm_arch = vm.arch
        diag.vm_cpus = vm.cpus
        diag.vm_memory_bytes = vm.memory
        diag.vm_disk_bytes = vm.disk
        diag.vm_dir = vm.dir
        diag.vm_ssh_local_port = vm.sshLocalPort
      } else {
        diag.vm_status = 'not_found'
      }
      diag.total_vms = vms.length
    } catch (e: any) { diag.vm_list_error = e.message?.slice(0, 500) }

    // LIMA_HOME directory state
    try {
      diag.lima_home_exists = fs.existsSync(limaHome)
      if (diag.lima_home_exists) {
        const entries = fs.readdirSync(limaHome)
        diag.lima_home_contents = entries
        // Check if VM directory exists and has key files
        const vmDir = path.join(limaHome, LIMA_VM_NAME)
        if (fs.existsSync(vmDir)) {
          diag.vm_dir_contents = fs.readdirSync(vmDir)
        }
      }
    } catch { /* ignore */ }

    // Nerdctl wrapper script state
    try {
      const wrapperPath = getNerdctlWrapperPath()
      diag.nerdctl_wrapper_exists = fs.existsSync(wrapperPath)
      if (diag.nerdctl_wrapper_exists) {
        diag.nerdctl_wrapper_content = fs.readFileSync(wrapperPath, 'utf-8')
      }
    } catch { /* ignore */ }

    // macOS virtualization framework availability
    if (process.platform === 'darwin') {
      try {
        diag.macos_version = execSync('sw_vers -productVersion', { encoding: 'utf-8', timeout: 3000 }).trim()
        diag.sip_status = execSync('csrutil status 2>&1 || true', { encoding: 'utf-8', timeout: 3000 }).trim()
      } catch { /* ignore */ }
    }

    // Disk space on LIMA_HOME volume
    if (process.platform !== 'win32') {
      try {
        const df = execSync(`df -k "${limaHome}" | tail -1`, { encoding: 'utf-8', timeout: 3000 })
        const parts = df.trim().split(/\s+/)
        if (parts.length >= 4) {
          diag.disk_free_mb = Math.round(parseInt(parts[3], 10) / 1024)
          diag.disk_total_mb = Math.round(parseInt(parts[1], 10) / 1024)
          diag.disk_used_percent = parts[4]
        }
      } catch { /* ignore */ }
    }

    // System memory
    diag.system_memory_free_mb = Math.round(os.freemem() / 1048576)
    diag.system_memory_total_mb = Math.round(os.totalmem() / 1048576)

  } catch {
    diag.diagnostic_error = 'failed to collect diagnostics'
  }

  return diag
}

export const LIMA_VM_NAME = 'superagent'

// Minimum Lima version that includes host-to-guest time sync (lima-vm/lima#4527).
// VMs created with older versions have a guest agent that lacks the SyncTime gRPC
// call, causing clock drift after macOS sleep/wake.
const MIN_LIMA_VM_VERSION = 'v2.1.1'

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
 *
 * Always uses ~/.superagent/lima (under the user's home directory) rather than
 * the app data dir (~/Library/Application Support/superagent/lima on macOS).
 * Lima creates Unix domain sockets under LIMA_HOME which are subject to
 * UNIX_PATH_MAX (104 on macOS). The longer Application Support path can
 * exceed this limit for users with long usernames.
 */
export function getLimaHome(): string {
  return path.join(os.homedir(), '.superagent', 'lima')
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
      ...getActiveLlmProvider().getContainerEnvVars(),
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
    addErrorBreadcrumb({ category: 'lima', message: 'Container run error', data: { error: msg, agentId: this.config.agentId } })

    const isKnownVmIssue =
      msg.includes('ENOENT') ||
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('not running') ||
      msg.includes('No such file') ||
      msg.includes('EACCES')

    // Check if the VM is in a broken/non-running state — if so, recovery is
    // worth attempting even for unexpected error messages (e.g. "Bad port '0'").
    let vmUnhealthy = false
    if (!isKnownVmIssue) {
      try {
        const { stdout } = await execLimactl('list --json')
        const vms = parseLimaList(stdout)
        const vm = vms.find((v: any) => v.name === LIMA_VM_NAME)
        vmUnhealthy = !vm || vm.status !== 'Running'
      } catch {
        vmUnhealthy = true
      }
    }

    if (isKnownVmIssue || vmUnhealthy) {
      console.log(`Lima VM not ready (${vmUnhealthy ? 'unhealthy VM' : 'known issue'}), attempting to provision...`)
      try {
        await ensureLimaReady()
        return true
      } catch (err) {
        captureException(err, {
          tags: { component: 'lima', operation: 'provision' },
          extra: { originalError: msg, agentId: this.config.agentId, vmUnhealthy, ...collectLimaDiagnostics() },
        })
        console.error('Failed to provision Lima VM:', err)
        return false
      }
    }

    captureException(error, {
      tags: { component: 'lima', operation: 'container-run' },
      extra: { agentId: this.config.agentId, ...collectLimaDiagnostics() },
    })
    return false
  }

  /**
   * nerdctl stats output matches Docker format.
   * No override needed — base class implementation works.
   */

  /**
   * Force-stop by killing the Lima VM directly (QEMU process).
   * Called when nerdctl stop + kill both time out because the VM is unresponsive.
   */
  protected async forceStop(): Promise<void> {
    console.warn('Force-stopping Lima VM (killing QEMU process)')
    try {
      await Promise.race([
        execLimactl(`stop --force ${LIMA_VM_NAME}`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Lima force-stop timed out')), 10000)
        ),
      ])
    } catch {
      console.error('Lima VM force-stop failed')
    }
  }

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
      const running = vms.some((vm: any) => vm.name === LIMA_VM_NAME && vm.status === 'Running')
      if (running) {
        // Ensure the nerdctl wrapper points to the current limactl binary.
        // The wrapper hardcodes the limactl path, which goes stale on app updates.
        createNerdctlWrapper()
      }
      return running
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

  addErrorBreadcrumb({ category: 'lima', message: 'ensureLimaReady started', data: { limaHome } })

  const settings = getSettings()
  const explicitMemory = settings.container.runtimeSettings?.lima?.vmMemory

  // Check if VM exists and whether its config matches
  let vmExists = false
  let vmMemory: string | null = null
  let vmBroken = false
  try {
    const { stdout } = await execLimactl('list --json')
    const vms = parseLimaList(stdout)
    const vm = vms.find((vm: any) => vm.name === LIMA_VM_NAME)
    if (vm) {
      vmExists = true
      vmMemory = vm.memory ? `${Math.round(vm.memory / (1024 * 1024 * 1024))}GiB` : null
      vmBroken = vm.status === 'Broken'
    }
  } catch (err) {
    addErrorBreadcrumb({ category: 'lima', message: 'limactl list failed', level: 'warning', data: { error: String(err) } })
  }

  // Check if existing VM was created with an older Lima that lacks time sync support
  let needsRecreate = false
  if (vmExists) {
    try {
      const versionFile = path.join(limaHome, LIMA_VM_NAME, 'lima-version')
      const vmVersion = fs.readFileSync(versionFile, 'utf-8').trim()
      if (vmVersion < MIN_LIMA_VM_VERSION) {
        console.log(`Lima VM was created with ${vmVersion} (< ${MIN_LIMA_VM_VERSION}), recreating for time sync support...`)
        needsRecreate = true
      }
    } catch {
      // Missing lima-version file — very old VM, recreate
      console.log('Lima VM missing version file, recreating...')
      needsRecreate = true
    }
  }

  // Recreate VM if it's in a broken state (e.g. host ran out of memory)
  if (vmExists && !needsRecreate && vmBroken) {
    console.log('Lima VM is in Broken state, recreating...')
    addErrorBreadcrumb({ category: 'lima', message: 'VM is Broken, will recreate', data: { vmMemory } })
    needsRecreate = true
  }

  // Recreate VM if the user has explicitly set a memory preference and it differs
  if (vmExists && !needsRecreate && explicitMemory && vmMemory && vmMemory !== explicitMemory) {
    console.log(`Lima VM memory mismatch (current: ${vmMemory}, desired: ${explicitMemory}), recreating...`)
    needsRecreate = true
  }

  if (vmExists && needsRecreate) {
    try {
      await execLimactl(`stop ${LIMA_VM_NAME} --force`)
    } catch { /* may not be running */ }
    await execLimactl(`delete ${LIMA_VM_NAME} --force`)
    vmExists = false
  }

  if (!vmExists) {
    console.log('Creating Lima VM for Superagent...')
    addErrorBreadcrumb({ category: 'lima', message: 'Creating new Lima VM', data: { explicitMemory } })
    try {
      await createLimaVm()
    } catch (err) {
      captureException(err, {
        tags: { component: 'lima', operation: 'create-vm' },
        extra: { limaHome, explicitMemory, arch: process.arch, ...collectLimaDiagnostics() },
      })
      throw err
    }
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
    addErrorBreadcrumb({ category: 'lima', message: 'Starting Lima VM' })
    try {
      await execLimactl(`start ${LIMA_VM_NAME}`)
    } catch (error) {
      captureException(error, {
        tags: { component: 'lima', operation: 'start-vm' },
        extra: { limaHome, vmExists, explicitMemory, ...collectLimaDiagnostics() },
      })
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
  addErrorBreadcrumb({ category: 'lima', message: 'ensureLimaReady completed successfully' })
}

/**
 * Stop the Lima VM gracefully with a timeout.
 * Used during app shutdown — must not hang indefinitely.
 * If the graceful stop times out (e.g., VM CPU is pegged), escalates to
 * force-stop which kills the QEMU process directly.
 */
export async function stopLimaVm(timeoutMs = 10000): Promise<void> {
  // Always use force-stop: graceful `limactl stop` takes 20-25s due to Lima's
  // hostagent cleanup and VZ driver shutdown sequence (lima-vm/lima#254).
  // Force-stop is safe here because all containers are already stopped before
  // this is called, and the VM filesystem is journaled.
  try {
    await Promise.race([
      execLimactl(`stop --force ${LIMA_VM_NAME}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Lima VM force-stop timed out')), timeoutMs)
      ),
    ])
  } catch {
    console.error('Lima VM force-stop failed or timed out')
  }
}

/**
 * Get the bundled Alpine cloud image path if available.
 * Falls back to null (will download from Alpine CDN at runtime).
 */
function getBundledVmImagePath(): string | null {
  if (typeof process !== 'undefined' && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'lima', 'alpine.qcow2')
    if (fs.existsSync(bundled)) {
      return bundled
    }
  }
  return null
}

async function createLimaVm(): Promise<void> {
  const settings = getSettings()
  const vmMemory = settings.container.runtimeSettings?.lima?.vmMemory || DEFAULT_LIMA_VM_MEMORY

  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'

  // Use bundled Alpine cloud image if available, otherwise download from CDN
  const bundledImage = getBundledVmImagePath()
  const imageLocation = bundledImage
    ? `file://${bundledImage}`
    : `https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/cloud/nocloud_alpine-3.23.3-${arch}-uefi-cloudinit-r0.qcow2`
  if (bundledImage) {
    console.log(`Using bundled Alpine image: ${bundledImage}`)
  } else {
    console.log(`Bundled image not found, will download from Alpine CDN`)
  }

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
    'images:',
    `  - location: "${imageLocation}"`,
    `    arch: "${arch}"`,
    '',
    '# Disable Lima built-in containerd management — we install via provision script',
    'containerd:',
    '  system: false',
    '  user: false',
    '',
    '# Install containerd + nerdctl on first boot, then start containerd',
    'provision:',
    '  - mode: system',
    '    script: |',
    '      #!/bin/sh',
    '      if ! command -v nerdctl >/dev/null 2>&1; then',
    '        echo "Installing containerd + nerdctl..."',
    '        apk update',
    '        apk add --no-cache containerd~=2.2 containerd-openrc nerdctl~=2.1 buildkit~=0.25 cni-plugins',
    '        rc-update add containerd default',
    '      fi',
    '      service containerd start || true',
  ]

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
 * Create/update the nerdctl wrapper shell script.
 * The script sets LIMA_HOME and delegates to limactl shell → nerdctl.
 * This works as both a command string (for exec) and a binary (for spawn).
 *
 * Called from isRunning() (to keep the wrapper current across app updates)
 * and from ensureLimaReady() (after VM provisioning).
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
