import os from 'os'
import fs from 'fs'
import { execFile } from 'child_process'
import type { AppSettings } from '../config/settings'
import { getDataDir } from '../config/data-dir'

/**
 * The environment fingerprint attached to error reports, in two halves per
 * context:
 *
 * - `collect*` reads what the process can answer itself. It is synchronous,
 *   spawns nothing and runs on the startup path, so a report sent right after
 *   has it.
 * - `probe*` asks what only another program or the file system can answer (a
 *   container runner's version, free disk space). It is asynchronous and never
 *   awaited by startup: the caller merges its result into the context when it
 *   arrives.
 *
 * Nothing here may spawn synchronously: this runs in the Electron main process
 * before the window exists (`environment.test.ts` pins that).
 */

const UNKNOWN = 'unknown'

/** A program's trimmed output without blocking the thread; 'unknown' when it fails or times out. Never rejects. */
function run(file: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { encoding: 'utf-8', timeout, windowsHide: true }, (error, stdout) => {
        resolve(error ? UNKNOWN : String(stdout).trim())
      })
    } catch {
      resolve(UNKNOWN)
    }
  })
}

const MACOS_SYSTEM_VERSION_PLIST = '/System/Library/CoreServices/SystemVersion.plist'

/**
 * The macOS version and build, from the file `sw_vers` itself prints
 * (`-productVersion` is its ProductVersion, `-buildVersion` its
 * ProductBuildVersion). Electron's `process.getSystemVersion()` is only the
 * fallback for the version: it always has three parts ("15.5.0" where
 * `sw_vers` says "15.5"), and there is no in-process source for the build.
 */
function macosVersion(): { version: string; build: string } {
  let plist = ''
  try {
    plist = fs.readFileSync(MACOS_SYSTEM_VERSION_PLIST, 'utf-8')
  } catch { /* fall back below */ }
  const value = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1]?.trim()
  let version = value('ProductVersion')
  if (!version) {
    try {
      version = process.getSystemVersion?.()
    } catch { /* not Electron */ }
  }
  return { version: version || UNKNOWN, build: value('ProductBuildVersion') || UNKNOWN }
}

/**
 * Only an x64 process can be running under Rosetta, so every other
 * architecture is answered without asking; an x64 one is asked in
 * {@link probeEnvironmentData}.
 */
function mayRunUnderRosetta(): boolean {
  return process.platform === 'darwin' && process.arch === 'x64'
}

async function getDiskSpaceGB(dir: string): Promise<{ total: number; free: number } | null> {
  try {
    // Sizes are in blocks of `bsize` bytes. `bavail` is what an unprivileged
    // user can still write, the "Available" column of `df`.
    const stats = await fs.promises.statfs(dir)
    const total = Math.round(stats.blocks * stats.bsize / 1073741824)
    const free = Math.round(stats.bavail * stats.bsize / 1073741824)
    if (Number.isFinite(total) && Number.isFinite(free)) return { total, free }
  } catch {
    // ignore
  }
  return null
}

/**
 * Collect the environment fingerprint the process can answer itself.
 *
 * Synchronous and spawn-free. This function MUST never throw — every
 * individual check is wrapped so a failure in one doesn't prevent the rest
 * from being collected.
 */
export function collectEnvironmentData(): Record<string, unknown> {
  const data: Record<string, unknown> = {}

  // OS basics — these Node APIs are very stable
  try {
    const cpus = os.cpus()
    data.os_type = os.type()
    data.os_platform = os.platform()
    data.os_release = os.release()
    data.os_arch = os.arch()
    data.os_hostname_hash = simpleHash(os.hostname())
    data.cpu_model = cpus[0]?.model ?? 'unknown'
    data.cpu_cores = cpus.length
    data.memory_total_gb = Math.round(os.totalmem() / 1073741824 * 10) / 10
    data.memory_free_gb = Math.round(os.freemem() / 1073741824 * 10) / 10
  } catch { /* partial data is fine */ }

  try {
    data.os_version = os.version()
  } catch { /* os.version() not available on older Node */ }

  // Node & Electron
  try {
    data.node_version = process.version
    data.electron_version = process.versions.electron ?? 'N/A'
    data.chrome_version = process.versions.chrome ?? 'N/A'
  } catch { /* partial data is fine */ }

  // macOS-specific
  if (process.platform === 'darwin') {
    try {
      const { version, build } = macosVersion()
      data.macos_version = version
      data.macos_build = build
      if (!mayRunUnderRosetta()) data.rosetta = false
    } catch { /* partial data is fine */ }
  }

  return data
}

/**
 * The rest of {@link collectEnvironmentData}'s context: what needs another
 * program. Empty where nothing does (a native arm64 Mac, Linux). Never rejects.
 */
export async function probeEnvironmentData(): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}
  try {
    if (mayRunUnderRosetta()) {
      // The key is missing on an Intel Mac: the command fails, which is "no".
      data.rosetta = await run('sysctl', ['-n', 'sysctl.proc_translated']) === '1'
    }
    if (process.platform === 'win32') {
      // The full build with its update revision, which os.release() leaves out.
      data.windows_build = await run('cmd', ['/c', 'ver'])
    }
  } catch { /* partial data is fine */ }
  return data
}

/**
 * The part of the fingerprint that comes from settings (container runner,
 * image, limits) and the data dir. Separate from {@link collectEnvironmentData}
 * because settings live in the database, which error reporting starts before:
 * the entry point adds this once the database is open. Synchronous and
 * spawn-free; never throws.
 */
export function collectSettingsEnvironmentData(settings: Pick<AppSettings, 'container'>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  try {
    data.data_dir = getDataDir()
    data.container_runner = settings.container.containerRunner
    data.agent_image = settings.container.agentImage
    data.resource_limits_cpu = settings.container.resourceLimits.cpu
    data.resource_limits_memory = settings.container.resourceLimits.memory
    if (settings.container.containerRunner === 'lima') {
      data.lima_vm_memory = settings.container.runtimeSettings?.lima?.vmMemory ?? 'default'
    }
  } catch { /* partial data is fine */ }

  return data
}

/**
 * The rest of {@link collectSettingsEnvironmentData}'s context: the data
 * dir's disk space and the container runner's version. Never rejects.
 */
export async function probeSettingsEnvironmentData(settings: Pick<AppSettings, 'container'>): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {}
  try {
    const [disk, runnerVersion] = await Promise.all([diskSpaceOfDataDir(), containerRunnerVersion(settings)])
    data.disk_total_gb = disk?.total ?? UNKNOWN
    data.disk_free_gb = disk?.free ?? UNKNOWN
    Object.assign(data, runnerVersion)
  } catch { /* partial data is fine */ }
  return data
}

async function diskSpaceOfDataDir(): Promise<{ total: number; free: number } | null> {
  try {
    return await getDiskSpaceGB(getDataDir())
  } catch {
    return null
  }
}

async function containerRunnerVersion(settings: Pick<AppSettings, 'container'>): Promise<Record<string, unknown>> {
  try {
    const runner = settings.container.containerRunner
    if (runner === 'docker') return { docker_version: await run('docker', ['--version']) }
    if (runner === 'podman') return { podman_version: await run('podman', ['--version']) }
    if (runner === 'lima') return { limactl_version: await run(await limactlPath(), ['--version']) }
    if (runner === 'wsl2') return { wsl_version: await run('wsl', ['--version']) }
  } catch { /* partial data is fine */ }
  return {}
}

/** The limactl the packaged app ships, or the one on PATH. */
async function limactlPath(): Promise<string> {
  if (!process.resourcesPath) return 'limactl'
  const bundled = `${process.resourcesPath}/lima/bin/limactl`
  return fs.promises.access(bundled).then(() => bundled, () => 'limactl')
}

function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}
