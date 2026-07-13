import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { BaseContainerClient, checkCommandAvailable, execWithPath, writeEnvFile } from './base-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { DEFAULT_LIMA_VM_MEMORY } from './types'
import type { ContainerConfig } from './types'
import os from 'os'
import { captureException, captureMessage, addErrorBreadcrumb } from '@shared/lib/error-reporting'

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
function execLimactl(args: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
  const limaHome = getLimaHome()
  const limactl = getLimactlPath()
  return execWithPath(`LIMA_HOME="${limaHome}" "${limactl}" ${args}`, opts)
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

/** Path to the Lima host-agent Unix socket (`ha.sock`) for our VM. */
function getHostAgentSocketPath(): string {
  return path.join(getLimaHome(), LIMA_VM_NAME, 'ha.sock')
}

/** Path to the Lima host-agent pid file (`ha.pid`) for our VM. */
function getHostAgentPidPath(): string {
  return path.join(getLimaHome(), LIMA_VM_NAME, 'ha.pid')
}

/**
 * Is the Lima host-agent process recorded in `ha.pid` still alive?
 *
 * This is the load-bearing guardrail for self-heal (SUP-291): a DEAD host agent
 * means leftover `ha.sock`/`ha.pid` are stale and safe to remove before a fresh
 * `limactl start`; a LIVE host agent means the VM process is up (possibly just
 * thrashing under memory pressure) and its sockets must NOT be touched — removing
 * them would orphan a live VM.
 *
 * Returns false when `ha.pid` is missing or unparseable (nothing known to be
 * alive). A surviving process (kill(pid, 0) succeeds, or fails EPERM) is alive.
 */
function isHostAgentAlive(): boolean {
  let pid: number
  try {
    pid = parseInt(fs.readFileSync(getHostAgentPidPath(), 'utf-8').trim(), 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // ESRCH → no such process (dead). EPERM → exists but not signalable (alive).
    return e?.code === 'EPERM'
  }
}

/**
 * Remove stale host-agent artifacts (`ha.pid`, `ha.sock`, and any orphaned
 * `*.sock`) from a dirty Lima instance dir so the next `limactl start` succeeds
 * instead of failing forever with "failed to connect to …/ha.sock: no such file
 * or directory" (ELECTRON-4S) after a force-/OOM-killed vz left the dir dirty.
 *
 * GUARDRAIL: refuses to touch anything while the host agent is still alive —
 * removing a live VM's sockets would orphan it. Returns true if it was safe to
 * clean (agent dead), false if it bailed because the agent is alive.
 */
function cleanStaleHostAgentArtifacts(): boolean {
  if (isHostAgentAlive()) return false

  const vmDir = path.join(getLimaHome(), LIMA_VM_NAME)
  const removed: string[] = []
  const tryUnlink = (p: string) => {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p)
        removed.push(path.basename(p))
      }
    } catch { /* best-effort */ }
  }

  tryUnlink(getHostAgentPidPath())
  tryUnlink(getHostAgentSocketPath())
  // Sweep any other orphaned Unix sockets the dead VM left behind (e.g. ssh.sock).
  try {
    for (const entry of fs.readdirSync(vmDir)) {
      if (entry.endsWith('.sock')) tryUnlink(path.join(vmDir, entry))
    }
  } catch { /* dir may not exist yet */ }

  if (removed.length) {
    addErrorBreadcrumb({ category: 'lima', message: 'Cleaned stale host-agent artifacts', data: { removed } })
  }
  return true
}

/** How long to wait for the guest liveness probe before treating it as a timeout. */
const GUEST_PROBE_TIMEOUT_MS = 8000

export type LimaHealthState = 'healthy' | 'not-running' | 'dirty' | 'wedged'

/**
 * Real reachability check for the Lima VM — replaces blind trust in
 * `limactl list` status == "Running" (SUP-291). The two states that actually
 * cause the stuck "Checking runtime availability…" spinner — Running-but-dirty
 * and Running-but-wedged — are invisible to `limactl list`, so we probe.
 *
 * - `not-running`: VM absent or not Running per limactl. Normal start path.
 * - `dirty`:       Running per limactl, but the host agent is DEAD (`ha.sock`
 *                  missing or guest unreachable with a dead `ha.pid`). A force-/
 *                  OOM-killed vz left a dirty dir → safe to clean + restart.
 * - `wedged`:      Running, host agent ALIVE, but the guest doesn't answer a
 *                  liveness probe (timed out). Memory-wedge signature → surface
 *                  it, do NOT rebuild (would orphan a live VM and fix nothing).
 * - `healthy`:     Running, `ha.sock` present, guest answers the liveness probe.
 */
async function probeLimaHealth(): Promise<{ state: LimaHealthState; vmStatus?: string }> {
  let vmStatus: string | undefined
  try {
    const { stdout } = await execLimactl('list --json')
    vmStatus = parseLimaList(stdout).find((v: any) => v.name === LIMA_VM_NAME)?.status
  } catch {
    return { state: 'not-running' }
  }
  if (vmStatus !== 'Running') return { state: 'not-running', vmStatus }

  // VM claims Running. A dirty dir (force-/OOM-killed vz) loses `ha.sock`.
  if (!fs.existsSync(getHostAgentSocketPath())) {
    return { state: isHostAgentAlive() ? 'wedged' : 'dirty', vmStatus }
  }

  // Socket present — probe the guest for REAL reachability.
  if (await probeGuestReachable()) return { state: 'healthy', vmStatus }

  // Unreachable: distinguish a dead agent (orphaned socket → dirty, clean+restart)
  // from a live-but-thrashing agent (memory wedge → leave the live VM intact).
  return { state: isHostAgentAlive() ? 'wedged' : 'dirty', vmStatus }
}

/**
 * Short guest liveness probe via `limactl shell -- true`.
 *
 * Two bounded attempts: a single slow SSH round-trip on a healthy-but-busy VM
 * (heavy build / host I/O stall) shouldn't flip it to "wedged" — a false negative
 * that then sticks for the availability-cache TTL. Each attempt is hard-bounded
 * by exec's own timeout (SIGKILL), so a wedged guest can't leave the probe (or
 * its `limactl shell` child) dangling. Only genuine unreachability fails twice.
 */
async function probeGuestReachable(timeoutMs = GUEST_PROBE_TIMEOUT_MS): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await execLimactl(`shell ${LIMA_VM_NAME} -- true`, { timeoutMs })
      return true
    } catch {
      // timed out or errored — retry once, then conclude unreachable
    }
  }
  return false
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
   * The macOS host IP as seen from inside the Lima VM — the VM's default-route
   * gateway, which VZ NAT routes to the host. Containers reach the host here via
   * host.docker.internal, and it is a real host interface (the vmnet host side),
   * NOT loopback — so a host-side proxy exposing the loopback CDP port must bind
   * this IP, never 0.0.0.0 (SUP-217). Returns null if it can't be detected.
   */
  getHostBridgeIp(): string | null {
    try {
      const limaHome = getLimaHome()
      const limactl = getLimactlPath()
      const output = execSync(
        `LIMA_HOME="${limaHome}" "${limactl}" shell ${LIMA_VM_NAME} -- ip route show default`,
        { timeout: 10000 }
      ).toString().trim()
      // Output: "default via 192.168.64.1 dev enp0s1 ..."
      const match = output.match(/via\s+([\d.]+)/)
      if (match) return match[1]
    } catch (e) {
      console.warn('Failed to detect host IP for Lima VM:', e)
    }
    return null
  }

  /**
   * Add --add-host so containers can reach the macOS host via host.docker.internal.
   * Lima/nerdctl doesn't set this up automatically like Docker Desktop does.
   */
  protected getAdditionalRunFlags(): string {
    const ip = this.getHostBridgeIp()
    if (ip) {
      console.log(`Lima host IP detected: ${ip}`)
      return `--add-host host.docker.internal:${ip}`
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
   * Parse the host path of a bind mount the Lima VM can't access. The VM helper
   * (a separate process) is denied by macOS TCC + File Provider when nerdctl /
   * containerd stats a cloud-synced mount (iCloud Drive, Dropbox, …), failing
   * with EPERM ("operation not permitted") rather than ENOENT — even though the
   * Electron app itself can read the path. start() uses this to drop that one
   * mount and retry without it instead of aborting the whole container.
   *
   * Example stderr (nerdctl logs via logrus, which wraps the message in
   * msg="..." and escapes the inner quotes as \"):
   *   level=fatal msg="failed to stat \"/Users/x/Library/Mail\": stat
   *   /Users/x/Library/Mail: operation not permitted"
   */
  protected extractInaccessibleMountPath(error: any): string | null {
    const raw = error?.message || error?.stderr || String(error)
    if (!/operation not permitted/i.test(raw)) return null
    // nerdctl/containerd log via logrus, which escapes the inner quotes around
    // the path as \". Unescape first — otherwise the captured path keeps its \"
    // artifacts and the mount-drop filter (volumes.filter(v => v.includes(path)))
    // never matches, so the inaccessible mount is never dropped.
    const msg = raw.replace(/\\"/g, '"')
    // Pull the host path out of `stat "<path>"` (handles spaces) / `stat <path>:`.
    const m =
      msg.match(/(?:failed to )?stat(?:\s+host\s+path)?\s+"([^"]+)"/i) ||
      msg.match(/(?:failed to )?stat(?:\s+host\s+path)?\s+([^\s:"]+)/i)
    return m ? m[1] : null
  }

  /**
   * The bundled Lima VM's containerd store holds nothing but our images, so
   * beyond removing the tagged image it's safe to prune unused images and
   * build cache too — the corrupt layer content (e.g. a /etc/passwd truncated
   * by disk exhaustion during unpack) can survive a bare `rmi` via the build
   * cache or a shared parent layer and poison the rebuild. Running containers
   * and bind mounts are untouched; volumes are not pruned.
   */
  protected async removeCorruptImage(image: string): Promise<void> {
    await super.removeCorruptImage(image)
    await execWithPath(`${this.getRunnerShellCommand()} system prune -af`)
  }

  /**
   * Handle run errors by provisioning the Lima VM if needed.
   */
  protected async handleRunError(error: any): Promise<boolean> {
    const msg = error.message || error.stderr || String(error)
    addErrorBreadcrumb({ category: 'lima', message: 'Container run error', data: { error: msg, agentId: this.config.agentId } })

    // An inaccessible cloud-synced mount (EPERM-on-stat) is handled by start()
    // dropping that mount and retrying — it must NOT trigger VM reprovisioning
    // here, and it isn't a VM fault worth an error-level capture.
    if (this.extractInaccessibleMountPath(error)) {
      captureMessage('Container run failed: inaccessible bind mount (cloud-synced path)', {
        level: 'warning',
        tags: { component: 'lima', operation: 'mount-inaccessible' },
        extra: { originalError: msg, agentId: this.config.agentId },
      })
      return false
    }

    const isKnownVmIssue =
      msg.includes('ENOENT') ||
      msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('not running') ||
      msg.includes('No such file') ||
      msg.includes('EACCES')

    // Check if the VM is actually unusable — if so, recovery is worth attempting
    // even for unexpected error messages (e.g. "Bad port '0'"). Use the real
    // reachability probe, NOT `limactl list` trust (SUP-291): a Running-but-dirty
    // (missing ha.sock) or wedged VM also warrants recovery. ensureLimaReady()
    // then picks the safe action — clean+restart for dirty, surface-not-rebuild
    // for wedged — so routing both here is safe.
    let vmUnhealthy = false
    if (!isKnownVmIssue) {
      try {
        const { state } = await probeLimaHealth()
        vmUnhealthy = state !== 'healthy'
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
   * Probe the guest to learn WHY nerdctl stop + kill hung. The VM is likely
   * CPU-pegged or containerd is wedged, so every probe goes through `limactl
   * shell` (which SSHes into the guest) and is individually bounded — a probe
   * timing out is itself a signal the guest is unresponsive. All best-effort.
   */
  protected async collectStopFailureDiagnostics(containerName: string): Promise<Record<string, unknown>> {
    // Host/VM-level state (VM status, disk, host memory, limactl health).
    const diag: Record<string, unknown> = { ...collectLimaDiagnostics() }

    const probe = async (key: string, args: string, timeoutMs = 4000): Promise<void> => {
      try {
        const { stdout } = await Promise.race([
          execLimactl(args),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('probe timed out')), timeoutMs)
          ),
        ])
        diag[key] = stdout.trim().slice(0, 2000) || '(empty)'
      } catch (e: any) {
        diag[key] = `probe_failed: ${String(e?.message ?? e).slice(0, 200)}`
      }
    }

    const sh = (cmd: string) => `shell ${LIMA_VM_NAME} -- sh -c "${cmd}"`

    await Promise.all([
      // Guest load and memory pressure — the prime suspects for a wedged VM.
      probe('guest_loadavg', `shell ${LIMA_VM_NAME} -- cat /proc/loadavg`),
      probe('guest_meminfo', sh("grep -E 'MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree' /proc/meminfo")),
      probe('guest_uptime', `shell ${LIMA_VM_NAME} -- uptime`),
      // Top processes by CPU (busybox top) — what's actually pegging the VM.
      probe('guest_top', sh('top -bn1 2>/dev/null | head -20')),
      // Container runtime state — is containerd alive, and what state is this
      // container actually in (running / OOMKilled / dead / pid)?
      probe('nerdctl_ps', sh("sudo nerdctl ps -a --format '{{.Names}}|{{.Status}}|{{.ID}}' 2>&1")),
      probe('container_state', sh(`sudo nerdctl inspect ${containerName} --format '{{json .State}}' 2>&1`)),
      probe('containerd_status', sh('rc-service containerd status 2>&1 || echo unknown')),
    ])

    return diag
  }

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
   * Check if the Lima VM named 'superagent' is actually usable.
   *
   * Does NOT trust `limactl list` status alone (SUP-291): a force-/OOM-killed vz
   * can report "Running" while the host agent is gone (dirty dir → ELECTRON-4S)
   * or the guest is wedged (memory pressure). Only a VM that passes the real
   * reachability probe counts as running; a `dirty` or `wedged` VM reports false
   * so the start path can self-heal it (dirty) or surface it (wedged) instead of
   * the app blindly proceeding into hung container ops.
   */
  static async isRunning(): Promise<boolean> {
    try {
      const { state } = await probeLimaHealth()
      if (state === 'healthy') {
        // Ensure the nerdctl wrapper points to the current limactl binary.
        // The wrapper hardcodes the limactl path, which goes stale on app updates.
        createNerdctlWrapper()
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * One-time check for Lima-specific runtime reconciliation.
   *
   * If the VM was created with an older bundled Lima that lacks time sync
   * support, rebuild it. Returns true if the VM was rebuilt.
   */
  static async reconcileRuntimeState(): Promise<boolean> {
    if (limaRuntimeReconciled) return false

    const staleVersion = getLimaVmStaleVersion()
    if (!staleVersion) {
      limaRuntimeReconciled = true
      return false
    }

    captureMessage(`Stale Lima VM detected (${staleVersion}) already running, rebuilding`, {
      level: 'warning',
      tags: { component: 'lima', operation: 'stale-vm-rebuild' },
      extra: { staleVersion },
    })

    await ensureLimaReady()
    limaRuntimeReconciled = true
    return true
  }
}

function getLimaVmStaleVersion(): string | null {
  try {
    const versionFile = path.join(getLimaHome(), LIMA_VM_NAME, 'lima-version')
    const vmVersion = fs.readFileSync(versionFile, 'utf-8').trim()
    return vmVersion < MIN_LIMA_VM_VERSION ? vmVersion : null
  } catch {
    return 'unknown'
  }
}

let limaRuntimeReconciled = false

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

  // Verify the VM's REAL health — don't trust `limactl list` status alone.
  // A freshly created or recreated VM hasn't been started yet, so skip the probe
  // and go straight to start.
  const health = vmExists && !needsRecreate ? await probeLimaHealth() : { state: 'not-running' as const }

  if (health.state === 'wedged') {
    // Running + live host agent + unreachable guest. Restarting/rebuilding a live
    // VM here would orphan it and fix nothing — surface the signal and bail with a
    // recoverable error instead of a destructive rebuild. (SUP-291 guardrail.)
    // The likely cause is host memory pressure, but a healthy VM under heavy load
    // can also land here, so don't over-assert the cause.
    captureMessage('Lima VM is Running with a live host-agent but the guest is unreachable (possible memory pressure or heavy load); not rebuilding', {
      level: 'warning',
      tags: { component: 'lima', operation: 'wedge-detected' },
      extra: { vmStatus: (health as { vmStatus?: string }).vmStatus, ...collectLimaDiagnostics() },
    })
    throw new Error(
      'Built-in runtime is unreachable — the host may be low on memory or under heavy load. ' +
      'Try again in a moment. (The VM was left running to avoid data loss.)'
    )
  }

  if (health.state !== 'healthy') {
    // not-running or dirty → (re)start. Self-heal a dirty instance dir first:
    // clean stale ha.pid/ha.sock/orphaned sockets a force-killed vz left behind
    // so `limactl start` succeeds instead of erroring on a missing ha.sock
    // forever (ELECTRON-4S). No-ops on a clean dir or a live VM (guardrail).
    cleanStaleHostAgentArtifacts()

    console.log('Starting Lima VM...')
    addErrorBreadcrumb({ category: 'lima', message: 'Starting Lima VM', data: { health: health.state } })
    try {
      await execLimactl(`start ${LIMA_VM_NAME}`)
    } catch (error) {
      captureException(error, {
        tags: { component: 'lima', operation: 'start-vm' },
        extra: { limaHome, vmExists, explicitMemory, health: health.state, ...collectLimaDiagnostics() },
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

    // The VM reported "Running" but its host agent was dead (missing/orphaned
    // ha.sock) and we just cleaned + restarted it. Record it as a real event
    // (not just a breadcrumb) so we can measure ELECTRON-4S self-heal rate in
    // prod and confirm the fix is working. (SUP-291)
    if (health.state === 'dirty') {
      captureMessage('Self-healed a dirty Lima instance dir (dead host-agent / missing ha.sock) and restarted the VM', {
        level: 'warning',
        tags: { component: 'lima', operation: 'dirty-dir-self-heal' },
        extra: { vmStatus: (health as { vmStatus?: string }).vmStatus },
      })
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
