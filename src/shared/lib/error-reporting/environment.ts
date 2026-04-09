import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'

function safeExec(cmd: string, timeout = 5000): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout }).trim()
  } catch {
    return 'unknown'
  }
}

function getDiskSpaceGB(dir: string): { total: number; free: number } | null {
  try {
    if (process.platform === 'win32') {
      const drive = dir.substring(0, 2)
      const output = safeExec(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace,Size /format:csv`)
      const lines = output.split('\n').filter(Boolean)
      const last = lines[lines.length - 1]?.split(',')
      if (last && last.length >= 3) {
        return {
          free: Math.round(parseInt(last[1], 10) / 1073741824),
          total: Math.round(parseInt(last[2], 10) / 1073741824),
        }
      }
    } else {
      const output = safeExec(`df -k "${dir}" | tail -1`)
      const parts = output.split(/\s+/)
      if (parts.length >= 4) {
        return {
          total: Math.round(parseInt(parts[1], 10) / 1048576),
          free: Math.round(parseInt(parts[3], 10) / 1048576),
        }
      }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Collect environment fingerprint data for error reports.
 *
 * This function MUST never throw — every individual check is wrapped
 * so a failure in one (e.g., getSettings() on corrupt config) doesn't
 * prevent the rest from being collected.
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

  // App settings — may fail if data dir isn't set or settings are corrupt
  try {
    const { getDataDir } = require('../config/data-dir')
    const { getSettings } = require('../config/settings')
    const settings = getSettings()
    const dataDir = getDataDir()
    const disk = getDiskSpaceGB(dataDir)

    data.data_dir = dataDir
    data.container_runner = settings.container.containerRunner
    data.agent_image = settings.container.agentImage
    data.resource_limits_cpu = settings.container.resourceLimits.cpu
    data.resource_limits_memory = settings.container.resourceLimits.memory
    data.disk_total_gb = disk?.total ?? 'unknown'
    data.disk_free_gb = disk?.free ?? 'unknown'

    // Container runtime versions
    const runner = settings.container.containerRunner
    if (runner === 'docker') {
      data.docker_version = safeExec('docker --version')
    } else if (runner === 'podman') {
      data.podman_version = safeExec('podman --version')
    } else if (runner === 'lima') {
      data.lima_vm_memory = settings.container.runtimeSettings?.lima?.vmMemory ?? 'default'
      const bundledLimactl = process.resourcesPath
        ? `${process.resourcesPath}/lima/bin/limactl`
        : null
      if (bundledLimactl && fs.existsSync(bundledLimactl)) {
        data.limactl_version = safeExec(`"${bundledLimactl}" --version`)
      } else {
        data.limactl_version = safeExec('limactl --version')
      }
    } else if (runner === 'wsl2') {
      data.wsl_version = safeExec('wsl --version')
    }
  } catch { /* settings not available yet — that's ok */ }

  // macOS-specific
  if (process.platform === 'darwin') {
    data.macos_version = safeExec('sw_vers -productVersion')
    data.macos_build = safeExec('sw_vers -buildVersion')
    data.rosetta = safeExec('sysctl -n sysctl.proc_translated') === '1'
  }

  // Windows-specific
  if (process.platform === 'win32') {
    data.windows_build = safeExec('cmd /c ver')
  }

  return data
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
