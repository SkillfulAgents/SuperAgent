import { spawn, execSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import net from 'net'
import os from 'os'
import { getDataDir, getAgentDownloadsDir } from '@shared/lib/config/data-dir'
import { listChromeProfiles, copyChromeProfileData } from '@shared/lib/browser/chrome-profile'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo } from './types'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'

interface BrowserCandidate {
  browser: string
  paths: string[]
}

const BROWSER_CANDIDATES: Record<string, BrowserCandidate> = {
  darwin: {
    browser: 'chrome',
    paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  },
  linux: {
    browser: 'chrome',
    paths: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser'],
  },
  win32: {
    browser: 'chrome',
    paths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  },
}

interface BrowserInstance {
  process: ChildProcess
  port: number
  proxyPort: number | null
  proxyServer: net.Server | null
  userDataDir: string
  stoppingIntentionally: boolean
}

/**
 * Collect diagnostic data about the Chrome environment at the moment of failure.
 * Runs quick ad-hoc checks to surface the actual root cause.
 */
function collectChromeDiagnostics(chromePath: string | null, port: number, userDataDir: string): Record<string, unknown> {
  const diag: Record<string, unknown> = {}

  try {
    // Is the Chrome binary actually there and executable?
    if (chromePath) {
      try {
        fs.accessSync(chromePath, fs.constants.X_OK)
        diag.chrome_binary_exists = true
        diag.chrome_binary_size = fs.statSync(chromePath).size
      } catch (e: any) {
        diag.chrome_binary_exists = false
        diag.chrome_binary_error = e.code // ENOENT, EACCES, etc.
      }
    }

    // Is another Chrome already running? (common cause of CDP port conflicts)
    if (process.platform === 'darwin') {
      try {
        const pgrep = execSync('pgrep -f "Google Chrome" 2>/dev/null || true', { encoding: 'utf-8', timeout: 3000 }).trim()
        const pids = pgrep.split('\n').filter(Boolean)
        diag.other_chrome_processes = pids.length
      } catch { diag.other_chrome_processes = 'check_failed' }
    } else if (process.platform === 'win32') {
      try {
        const tasklist = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH 2>nul', { encoding: 'utf-8', timeout: 3000 }).trim()
        diag.other_chrome_processes = tasklist.split('\n').filter(l => l.includes('chrome.exe')).length
      } catch { diag.other_chrome_processes = 'check_failed' }
    }

    // Is something already bound to our target port?
    if (process.platform !== 'win32') {
      try {
        const lsof = execSync(`lsof -i :${port} -t 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000 }).trim()
        diag.port_in_use_by_pids = lsof || 'none'
      } catch { diag.port_in_use_by_pids = 'check_failed' }
    }

    // Is the user-data-dir writable? Is there a lock file from a previous crash?
    try {
      const lockFile = path.join(userDataDir, 'SingletonLock')
      diag.singleton_lock_exists = fs.existsSync(lockFile)
      if (diag.singleton_lock_exists) {
        try {
          diag.singleton_lock_target = fs.readlinkSync(lockFile)
        } catch {
          diag.singleton_lock_target = 'not_a_symlink'
        }
      }
    } catch { /* ignore */ }

    // Check for DevToolsActivePort file (Chrome writes this on successful CDP bind)
    try {
      const dtFile = path.join(userDataDir, 'DevToolsActivePort')
      diag.devtools_active_port_exists = fs.existsSync(dtFile)
      if (diag.devtools_active_port_exists) {
        diag.devtools_active_port_content = fs.readFileSync(dtFile, 'utf-8').trim()
      }
    } catch { /* ignore */ }

    // Disk space on the data dir volume
    if (process.platform !== 'win32') {
      try {
        const df = execSync(`df -k "${path.dirname(userDataDir)}" | tail -1`, { encoding: 'utf-8', timeout: 3000 })
        const parts = df.trim().split(/\s+/)
        if (parts.length >= 4) {
          diag.disk_free_mb = Math.round(parseInt(parts[3], 10) / 1024)
        }
      } catch { /* ignore */ }
    }

    // Chrome version
    if (chromePath) {
      if (process.platform === 'darwin') {
        try {
          const plistPath = path.join(path.dirname(chromePath), '..', 'Info.plist')
          const plist = fs.readFileSync(plistPath, 'utf-8')
          const vMatch = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
          diag.chrome_version = vMatch?.[1] ?? 'unknown'
        } catch { diag.chrome_version = 'check_failed' }
      } else if (process.platform === 'win32') {
        try {
          diag.chrome_version = execSync(`"${chromePath}" --version 2>nul`, { encoding: 'utf-8', timeout: 5000 }).trim()
        } catch { diag.chrome_version = 'check_failed' }
      }
    }

    // System memory pressure
    diag.system_memory_free_mb = Math.round(os.freemem() / 1048576)
    diag.system_memory_total_mb = Math.round(os.totalmem() / 1048576)

  } catch {
    diag.diagnostic_error = 'failed to collect diagnostics'
  }

  return diag
}

export class ChromeProvider implements HostBrowserProvider {
  readonly id = 'chrome' as const
  readonly name = 'Google Chrome'

  private instances: Map<string, BrowserInstance> = new Map()
  private detectedPath: string | null = null

  onExternalClose: ((instanceId: string) => void) | null = null

  detect(): HostBrowserProviderStatus {
    const candidate = BROWSER_CANDIDATES[process.platform]
    if (!candidate) {
      return { id: this.id, name: this.name, available: false, reason: 'Unsupported platform' }
    }

    for (const p of candidate.paths) {
      if (fs.existsSync(p)) {
        this.detectedPath = p
        return {
          id: this.id,
          name: this.name,
          available: true,
          profiles: listChromeProfiles(),
        }
      }
    }

    return { id: this.id, name: this.name, available: false, reason: 'Chrome not found on this system' }
  }

  async launch(instanceId: string, options?: Record<string, string>, _agentId?: string): Promise<BrowserConnectionInfo> {
    addErrorBreadcrumb({ category: 'browser', message: 'Launching host browser', data: { instanceId, platform: process.platform } })

    // Check if an instance already exists and its port is still open
    const existing = this.instances.get(instanceId)
    if (existing && await this.isPortOpen(existing.port)) {
      return { port: existing.proxyPort ?? existing.port }
    }

    // If an instance exists but port is gone, clean up the stale entry
    if (existing) {
      await this.stop(instanceId)
    }

    const status = this.detect()
    if (!status.available) {
      const err = new Error(`No supported browser detected: ${status.reason || 'unknown reason'}`)
      captureException(err, {
        tags: { component: 'browser', operation: 'detect' },
        extra: { instanceId, platform: process.platform, reason: status.reason },
      })
      throw err
    }

    const port = await this.findFreePort()
    const profileId = options?.chromeProfileId

    // Chrome refuses to enable CDP on its default (real) data directory:
    //   "DevTools remote debugging requires a non-default data directory"
    // So we always use a dedicated user-data-dir per instance. When a profile is
    // selected, we copy session data (cookies, login data, etc.) from the real
    // Chrome profile into our dedicated dir before launching.
    const userDataDir = path.join(getDataDir(), 'host-browser-profiles', instanceId)
    fs.mkdirSync(userDataDir, { recursive: true })

    if (profileId) {
      const destProfileDir = path.join(userDataDir, 'Default')
      // Only copy the user's Chrome profile on first launch. Subsequent launches
      // should keep the session data (cookies, local storage, etc.) that the
      // agent accumulated during its browsing sessions.
      const alreadyHasProfile = fs.existsSync(path.join(destProfileDir, 'Cookies'))
      if (!alreadyHasProfile && copyChromeProfileData(profileId, destProfileDir)) {
        console.log(`[ChromeProvider] Copied Chrome profile "${profileId}" for instance ${instanceId}`)
      }
    }

    // Set Chrome download preferences so files go to the agent's workspace
    // instead of the user's ~/Downloads folder.
    const downloadDir = getAgentDownloadsDir(instanceId)
    const prefsDir = path.join(userDataDir, 'Default')
    const prefsPath = path.join(prefsDir, 'Preferences')
    fs.mkdirSync(prefsDir, { recursive: true })
    let prefs: Record<string, unknown> = {}
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'))
    } catch {
      // No existing preferences file
    }
    prefs.download = {
      ...(prefs.download as Record<string, unknown> | undefined),
      default_directory: downloadDir,
      prompt_for_download: false,
    }
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2))

    const browserProcess = spawn(
      this.detectedPath!,
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=0.0.0.0',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        // Prevent Chrome from throttling rendering when the window is behind
        // other windows. Without these, screencast frames stop flowing.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-features=CalculateNativeWinOcclusion,WebContentsOcclusion',
        // Start with about:blank instead of chrome://newtab so agent-browser's
        // target discovery sees a trackable page and reuses it rather than
        // creating an extra tab (it filters out chrome:// URLs).
        'about:blank',
      ],
      { detached: false, stdio: ['ignore', 'ignore', 'pipe'] }
    )

    // Collect stderr for diagnostics if Chrome fails to start
    const stderrChunks: Buffer[] = []
    browserProcess.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    // Track early process failure so waitForPort can report a useful error
    let earlyExitCode: number | null = null
    const earlyExitPromise = new Promise<never>((_, reject) => {
      browserProcess.on('error', (err) => {
        console.error(`[ChromeProvider] Browser process error for instance ${instanceId}:`, err)
        const stderr = Buffer.concat(stderrChunks).toString().trim()
        reject(new Error(
          `Failed to spawn browser: ${err.message}${stderr ? `\nChrome stderr: ${stderr}` : ''}`
        ))
      })
      browserProcess.on('exit', (code) => {
        earlyExitCode = code
      })
    })

    // Chrome on Windows ignores --remote-debugging-address=0.0.0.0 and always
    // binds its CDP port to 127.0.0.1. This means containers running inside WSL2
    // (via nerdctl) cannot reach Chrome directly — only Docker Desktop's special
    // networking layer makes host 127.0.0.1 ports accessible from containers.
    // To work around this, we run a lightweight TCP proxy on 0.0.0.0 that forwards
    // to Chrome's 127.0.0.1 CDP port, making it reachable from any network interface.
    let proxyPort: number | null = null
    let proxyServer: net.Server | null = null
    if (process.platform === 'win32') {
      proxyPort = await this.findFreePort()
      proxyServer = net.createServer((client) => {
        const target = net.connect(port, '127.0.0.1')
        client.pipe(target)
        target.pipe(client)
        client.on('error', () => target.destroy())
        target.on('error', () => client.destroy())
      })
      await new Promise<void>((resolve, reject) => {
        proxyServer!.listen(proxyPort!, '0.0.0.0', () => resolve())
        proxyServer!.on('error', reject)
      })
    }

    const instance: BrowserInstance = {
      process: browserProcess,
      port,
      proxyPort,
      proxyServer,
      userDataDir,
      stoppingIntentionally: false,
    }
    this.instances.set(instanceId, instance)

    // Now that the instance is registered, wire up the exit handler for
    // external-close notifications (separate from the earlyExitPromise above).
    browserProcess.on('exit', (code) => {
      console.log(`[ChromeProvider] Browser for instance ${instanceId} exited with code ${code}`)
      const wasIntentional = instance.stoppingIntentionally
      instance.proxyServer?.close()
      this.instances.delete(instanceId)
      if (!wasIntentional) {
        console.log(`[ChromeProvider] Browser for instance ${instanceId} closed externally, notifying listeners`)
        Promise.resolve(this.onExternalClose?.(instanceId)).catch((err) => {
          console.error('[ChromeProvider] Error in onExternalClose callback:', err)
        })
      }
    })

    try {
      // Race the port check against early process death / spawn errors.
      // If Chrome crashes or fails to spawn, we get an immediate error
      // instead of waiting the full 15s timeout.
      await Promise.race([
        this.waitForPort(port, 15000, () => earlyExitCode, () => Buffer.concat(stderrChunks).toString().trim()),
        earlyExitPromise,
      ])
    } catch (err) {
      const stderr = Buffer.concat(stderrChunks).toString().trim()
      // Run ad-hoc diagnostics to capture the actual root cause
      const diagnostics = collectChromeDiagnostics(this.detectedPath, port, userDataDir)
      captureException(err, {
        tags: { component: 'browser', operation: 'launch' },
        extra: {
          instanceId,
          port,
          platform: process.platform,
          arch: process.arch,
          chromePath: this.detectedPath,
          earlyExitCode,
          stderr: stderr.slice(-2000),
          userDataDir,
          profileId,
          spawnArgs: [
            `--remote-debugging-port=${port}`,
            '--remote-debugging-address=0.0.0.0',
            `--user-data-dir=${userDataDir}`,
          ],
          ...diagnostics,
        },
      })
      await this.stop(instanceId)
      throw err
    }

    const exposedPort = proxyPort ?? port
    console.log(`[ChromeProvider] Chrome CDP on port ${port}${proxyPort ? `, proxy on 0.0.0.0:${proxyPort}` : ''} for instance ${instanceId}`)
    return { port: exposedPort, downloadDir }
  }

  async stop(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId)
    if (instance) {
      instance.stoppingIntentionally = true
      instance.proxyServer?.close()
      if (!instance.process.killed) {
        instance.process.kill()
        // Wait for process to actually exit before removing from map.
        // Without this, the next launch() won't see the existing instance
        // and will spawn a new Chrome while this one is still dying.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try { instance.process.kill('SIGKILL') } catch { /* ignore */ }
            resolve()
          }, 5000)
          instance.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        })
      }
    }
    this.instances.delete(instanceId)
  }

  async stopAll(): Promise<void> {
    for (const instanceId of Array.from(this.instances.keys())) {
      await this.stop(instanceId)
    }
  }

  isRunning(instanceId?: string): boolean {
    if (instanceId) {
      const instance = this.instances.get(instanceId)
      return instance !== undefined && !instance.process.killed
    }
    return this.instances.size > 0
  }

  private async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port
        server.close(() => resolve(port))
      })
      server.on('error', reject)
    })
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(1000)
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('error', () => {
        resolve(false)
      })
      socket.connect(port, '127.0.0.1')
    })
  }

  private async waitForPort(port: number, timeoutMs: number, getExitCode?: () => number | null, getStderr?: () => string): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // If the process already exited, no point waiting for the port
      const exitCode = getExitCode?.()
      if (exitCode !== undefined && exitCode !== null) {
        const stderr = getStderr?.()
        throw new Error(
          `Browser process exited with code ${exitCode} before debug port ${port} became available` +
          (stderr ? `\nChrome stderr: ${stderr}` : '')
        )
      }
      if (await this.isPortOpen(port)) {
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`Browser debug port ${port} did not become available within ${timeoutMs}ms — the browser process may have failed to start`)
  }
}
