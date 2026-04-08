import { Hono } from 'hono'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { containerManager } from '@shared/lib/container/container-manager'
import { checkAllRunnersAvailability, type ContainerRunner } from '@shared/lib/container/client-factory'
import { getSettings } from '@shared/lib/config/settings'
import { execWithPath } from '@shared/lib/container/base-container-client'
import { getLimaHome, getLimactlPath } from '@shared/lib/container/lima-container-client'
import { APP_VERSION } from '@shared/lib/config/version'
import os, { platform } from 'os'
import fs from 'fs'

const debug = new Hono()

// GET /api/debug/system-info — lightweight system diagnostics (available to all authenticated users)
debug.get('/system-info', Authenticated(), (c) => {
  const cpus = os.cpus()

  let disk: { totalBytes: number; freeBytes: number } | null = null
  try {
    const stats = fs.statfsSync(os.homedir())
    disk = {
      totalBytes: stats.bsize * stats.blocks,
      freeBytes: stats.bsize * stats.bavail,
    }
  } catch {
    // statfsSync may fail on some platforms/configurations
  }

  return c.json({
    app: {
      version: APP_VERSION,
      electronVersion: process.versions.electron || null,
      chromeVersion: process.versions.chrome || null,
      nodeVersion: process.version,
    },
    os: {
      platform: platform(),
      type: os.type(),
      release: os.release(),
      version: os.version(),
      arch: process.arch,
    },
    hardware: {
      cpuModel: cpus[0]?.model || null,
      cpuCores: cpus.length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
    },
    disk,
    runtime: {
      uptime: os.uptime(),
    },
  })
})

debug.use('*', Authenticated(), IsAdmin())

// GET /api/debug/runtime — VM/runtime status info
debug.get('/runtime', async (c) => {
  const settings = getSettings()
  const runner = settings.container.containerRunner as ContainerRunner
  const availability = await checkAllRunnersAvailability()

  let vmStatus: Record<string, unknown> | null = null

  try {
    if (runner === 'lima') {
      const limaHome = getLimaHome()
      const limactl = getLimactlPath()
      const { stdout } = await execWithPath(
        `LIMA_HOME="${limaHome}" "${limactl}" list --json`
      )
      const vms = stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
      vmStatus = { type: 'lima', limaHome, limactlPath: limactl, vms }

      // Also check containerd status inside the VM
      try {
        const { stdout: containerdOut } = await execWithPath(
          `LIMA_HOME="${limaHome}" "${limactl}" shell superagent -- rc-service containerd status`
        )
        ;(vmStatus as any).containerdStatus = containerdOut.trim()
      } catch (e: any) {
        (vmStatus as any).containerdStatus = `Error: ${e.message}`
      }

      // Check disk usage
      try {
        const { stdout: dfOut } = await execWithPath(
          `LIMA_HOME="${limaHome}" "${limactl}" shell superagent -- df -h /`
        )
        ;(vmStatus as any).diskUsage = dfOut.trim()
      } catch { /* ignore */ }
    } else if (runner === 'wsl2' && platform() === 'win32') {
      try {
        const { stdout } = await execWithPath('wsl --list --verbose')
        // Strip null bytes from UTF-16LE
        const clean = stdout.replace(/\0/g, '')
        vmStatus = { type: 'wsl2', rawOutput: clean.trim() }
      } catch (e: any) {
        vmStatus = { type: 'wsl2', error: e.message }
      }
    } else if (runner === 'docker' || runner === 'podman') {
      try {
        const { stdout } = await execWithPath(`${runner} info --format '{{json .}}'`)
        vmStatus = { type: runner, info: JSON.parse(stdout) }
      } catch (e: any) {
        // Fallback: try without JSON format
        try {
          const { stdout } = await execWithPath(`${runner} info`)
          vmStatus = { type: runner, rawOutput: stdout.trim() }
        } catch {
          vmStatus = { type: runner, error: e.message }
        }
      }
    } else if (runner === 'apple-container') {
      try {
        const { stdout } = await execWithPath('container system info')
        vmStatus = { type: 'apple-container', rawOutput: stdout.trim() }
      } catch (e: any) {
        vmStatus = { type: 'apple-container', error: e.message }
      }
    }
  } catch (e: any) {
    vmStatus = { type: runner, error: e.message }
  }

  return c.json({
    configuredRunner: runner,
    platform: platform(),
    runners: availability,
    vmStatus,
    readiness: containerManager.getReadiness(),
  })
})

// GET /api/debug/containers — list all containers from the runtime
debug.get('/containers', async (c) => {
  const settings = getSettings()
  const runner = settings.container.containerRunner as ContainerRunner

  let runnerCmd: string
  if (runner === 'lima') {
    const limaHome = getLimaHome()
    const limactl = getLimactlPath()
    runnerCmd = `LIMA_HOME="${limaHome}" "${limactl}" shell superagent -- sudo nerdctl`
  } else if (runner === 'wsl2') {
    runnerCmd = `wsl -d superagent -- sudo nerdctl`
  } else {
    runnerCmd = runner === 'apple-container' ? 'container' : runner
  }

  try {
    const { stdout } = await execWithPath(`${runnerCmd} ps -a --format '{{json .}}'`)
    const containers = stdout.trim().split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
    return c.json({ containers })
  } catch (e: any) {
    // Fallback to non-JSON
    try {
      const { stdout } = await execWithPath(`${runnerCmd} ps -a`)
      return c.json({ raw: stdout.trim() })
    } catch (e2: any) {
      return c.json({ error: e2.message }, 500)
    }
  }
})

// GET /api/debug/containers/:name/logs?tail=100 — get container logs
debug.get('/containers/:name/logs', async (c) => {
  const name = c.req.param('name')
  const tail = parseInt(c.req.query('tail') || '100', 10)
  const settings = getSettings()
  const runner = settings.container.containerRunner as ContainerRunner

  let runnerCmd: string
  if (runner === 'lima') {
    const limaHome = getLimaHome()
    const limactl = getLimactlPath()
    runnerCmd = `LIMA_HOME="${limaHome}" "${limactl}" shell superagent -- sudo nerdctl`
  } else if (runner === 'wsl2') {
    runnerCmd = `wsl -d superagent -- sudo nerdctl`
  } else {
    runnerCmd = runner === 'apple-container' ? 'container' : runner
  }

  try {
    const { stdout, stderr } = await execWithPath(
      `${runnerCmd} logs --tail ${tail} ${name}`
    )
    return c.json({ logs: (stdout + stderr).trim() })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /api/debug/app-info — app paths and terminal launch commands
debug.get('/app-info', (c) => {
  const p = platform()
  let terminalCommand = ''

  if (p === 'darwin') {
    // Electron: process.execPath is /Applications/Superagent.app/Contents/MacOS/Superagent
    // In dev: it's the electron binary path
    const execPath = process.execPath
    if (execPath.includes('.app/Contents/MacOS/')) {
      terminalCommand = `"${execPath}"`
    } else {
      terminalCommand = `# Dev mode — run your dev server from the project directory\n# Logs already appear in your terminal`
    }
  } else if (p === 'win32') {
    const execPath = process.execPath
    if (execPath.includes('Superagent')) {
      terminalCommand = `& "${execPath}"`
    } else {
      terminalCommand = `# Dev mode — run your dev server from the project directory\n# Logs already appear in your terminal`
    }
  } else {
    // Linux
    const execPath = process.execPath
    terminalCommand = `"${execPath}"`
  }

  return c.json({
    platform: p,
    execPath: process.execPath,
    nodeVersion: process.version,
    electronVersion: process.versions.electron || null,
    terminalCommand,
  })
})

export default debug
