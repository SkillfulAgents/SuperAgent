import { spawn, execSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import net from 'net'
import os from 'os'
import { getDataDir, getAgentDownloadsDir } from '@shared/lib/config/data-dir'
import { listChromeProfiles, copyChromeProfileData } from '@shared/lib/browser/chrome-profile'
import { containerManager } from '@shared/lib/container/container-manager'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo } from './types'
import { captureException, addErrorBreadcrumb } from '@shared/lib/error-reporting'
import { readJsonFileStrictSync, writeFileAtomicSync, CorruptFileError } from '@shared/lib/utils/file-storage'
import { z } from 'zod'

// Chrome's DevTools Protocol has no auth token: any host/process that can reach
// the CDP port gets full remote control of the dedicated browser profile (read
// pages, cookies/session, drive navigation). So CDP must never bind to all
// interfaces (0.0.0.0). We bind it to loopback and, for runners whose containers
// reach the host through a real bridge interface rather than the host loopback
// (e.g. socket_vmnet Lima, WSL2/nerdctl, native Docker bridge), forward to it via
// a proxy bound to that single host-internal interface — never the LAN.
// Loopback-forwarding runners (Docker Desktop, user-mode Lima, rootless Podman)
// need no proxy.
const CDP_LOOPBACK_ADDRESS = '127.0.0.1'

/** True if `ip` is assigned to a local network interface (i.e. bindable by this host). */
function isLocalInterfaceAddress(ip: string): boolean {
  const interfaces = os.networkInterfaces()
  for (const addrs of Object.values(interfaces)) {
    if (addrs?.some((addr) => addr.address === ip)) return true
  }
  return false
}

interface BrowserCandidate {
  browser: string
  paths: string[]
}

const WIN_LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')

const BROWSER_CANDIDATES: Record<string, BrowserCandidate> = {
  darwin: {
    browser: 'chrome',
    paths: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ],
  },
  linux: {
    browser: 'chrome',
    paths: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/opt/google/chrome/chrome',
      '/snap/bin/google-chrome',
      '/snap/bin/chromium',
    ],
  },
  win32: {
    browser: 'chrome',
    paths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      path.join(WIN_LOCAL_APP_DATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
}

interface BrowserInstance {
  // On linux/win32 we spawn Chrome directly; on darwin we go through `open -g -n -a`
  // (so Chrome doesn't steal OS focus on launch), which means our spawned child is
  // `open` itself and Chrome is reparented to launchd. In the darwin case we set
  // process to null and rely on `pid` + a polling watcher for lifecycle.
  process: ChildProcess | null
  pid: number
  port: number
  proxyPort: number | null
  proxyServer: net.Server | null
  userDataDir: string
  stoppingIntentionally: boolean
  externalCloseWatcher: NodeJS.Timeout | null
}

/**
 * Look for a recent Chrome crash report on macOS (DiagnosticReports).
 * Returns the first few KB of the most recent .ips/.crash file written
 * in the last 30 seconds, or null if none found.
 */
function collectRecentCrashReport(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const dirs = [
      path.join(os.homedir(), 'Library/Logs/DiagnosticReports'),
      '/Library/Logs/DiagnosticReports',
    ]
    const cutoff = Date.now() - 30_000
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir)
        .filter(f => /Google Chrome/i.test(f) && /\.(ips|crash)$/.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .filter(f => f.mtime > cutoff)
        .sort((a, b) => b.mtime - a.mtime)
      if (files.length > 0) {
        return fs.readFileSync(path.join(dir, files[0].name), 'utf-8').slice(0, 4000)
      }
    }
  } catch { /* best-effort */ }
  return null
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

    // Remove stale Chrome lock files left behind by a previous crash. If the old
    // instance is still alive we already checked and stopped it above (lines 227-235),
    // so any remaining lock is orphaned and will cause Chrome to exit with code 0
    // thinking another instance owns this data dir.
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lockPath = path.join(userDataDir, lockName)
      try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ }
    }

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
    // Read Chrome's existing Preferences fail-closed: a missing file is
    // a fresh profile (→ {}), but a present-but-corrupt one must NOT be silently
    // replaced with just `{ download }` — that would wipe every other Chrome
    // preference. On corruption, skip the download tweak rather than clobber.
    let prefs: Record<string, unknown>
    try {
      prefs = readJsonFileStrictSync(prefsPath, z.object({}).loose(), {}) as Record<string, unknown>
    } catch (error) {
      if (error instanceof CorruptFileError) {
        console.warn(`[ChromeProvider] Corrupt Chrome Preferences at ${prefsPath}; leaving it untouched`)
        prefs = null as unknown as Record<string, unknown>
      } else {
        throw error
      }
    }
    if (prefs) {
      prefs.download = {
        ...(prefs.download as Record<string, unknown> | undefined),
        default_directory: downloadDir,
        prompt_for_download: false,
      }
      // Atomic write so an interrupted write can't truncate Chrome's Preferences.
      writeFileAtomicSync(prefsPath, JSON.stringify(prefs, null, 2))
    }

    const headless = options?.chromeHeadless === 'true'

    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=${CDP_LOOPBACK_ADDRESS}`,
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
    ]

    if (headless) {
      chromeArgs.unshift('--headless=new', '--window-size=1920,1080')
      const chromeVersion = this.getChromeVersion()
      if (chromeVersion) {
        const platformUA = process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : process.platform === 'darwin'
            ? 'Macintosh; Intel Mac OS X 10_15_7'
            : 'X11; Linux x86_64'
        chromeArgs.push(
          `--user-agent=Mozilla/5.0 (${platformUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
        )
      }
    }

    const spawnedAt = Date.now()

    // Collect stderr for diagnostics if Chrome fails to start
    const stderrChunks: Buffer[] = []
    // Track early process failure so waitForPort can report a useful error.
    // Initialise as `undefined` so we can distinguish "not exited yet" from
    // "exited with signal" (which Node reports as code === null).
    let earlyExitCode: number | null | undefined = undefined
    let earlyExitSignal: string | null = null
    let browserProcess: ChildProcess | null = null
    let chromePid: number
    let earlyExitPromise: Promise<never>
    // For darwin we poll the Chrome PID for early death; clear this after the
    // launch race resolves so polling doesn't leak.
    let earlyExitInterval: NodeJS.Timeout | null = null

    if (process.platform === 'darwin') {
      // On macOS, spawning Chrome directly causes it to activate and steal OS focus
      // from whatever app the user is currently in. `open -g -n -a` launches via
      // LaunchServices in the background:
      //   -g: don't bring the app to the foreground
      //   -n: open a new instance even if Chrome is already running
      //   -a: app bundle to open
      // Chrome is reparented to launchd, so our child here is `open` (which exits
      // shortly after dispatching the launch). We track Chrome by PID instead.
      const appBundlePath = path.dirname(path.dirname(path.dirname(this.detectedPath!))) // .../Google Chrome.app

      const openProc = spawn(
        'open',
        ['-g', '-n', '-a', appBundlePath, '--args', ...chromeArgs],
        { detached: false, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      const openStderr: Buffer[] = []
      openProc.stderr?.on('data', (chunk: Buffer) => { openStderr.push(chunk) })

      try {
        await new Promise<void>((resolve, reject) => {
          openProc.on('error', (err) => reject(new Error(`Failed to invoke 'open': ${err.message}`)))
          openProc.on('exit', (code) => {
            const stderr = Buffer.concat(openStderr).toString().trim()
            if (code === 0) resolve()
            else reject(new Error(`'open' exited with code ${code}${stderr ? `: ${stderr}` : ''}`))
          })
        })
      } catch (err) {
        captureException(err, {
          tags: { component: 'browser', operation: 'launch' },
          extra: { instanceId, platform: 'darwin', stage: 'open-dispatch' },
        })
        throw err
      }

      // Chrome processes appear in `ps` shortly after `open` returns. Retry briefly.
      const foundPid = await this.findChromePidByUserDataDir(userDataDir, 5000)
      if (!foundPid) {
        const err = new Error(`Chrome was launched via 'open' but the process could not be located for user-data-dir ${userDataDir}`)
        captureException(err, {
          tags: { component: 'browser', operation: 'launch' },
          extra: { instanceId, platform: 'darwin', stage: 'pid-lookup', userDataDir },
        })
        throw err
      }
      chromePid = foundPid

      // Watch the PID for early death. If Chrome exits before the port opens,
      // surface that quickly instead of waiting the full waitForPort timeout.
      earlyExitPromise = new Promise<never>((_, reject) => {
        earlyExitInterval = setInterval(() => {
          try {
            process.kill(chromePid, 0) // signal 0 = existence check
          } catch {
            if (earlyExitInterval) clearInterval(earlyExitInterval)
            earlyExitInterval = null
            earlyExitCode = -1
            reject(new Error(`Chrome process (PID ${chromePid}) exited before debug port ${port} became available`))
          }
        }, 250)
      })
    } else {
      browserProcess = spawn(
        this.detectedPath!,
        chromeArgs,
        { detached: false, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      if (browserProcess.pid == null) {
        const err = new Error('Failed to spawn Chrome: no PID assigned to child process')
        captureException(err, {
          tags: { component: 'browser', operation: 'launch' },
          extra: { instanceId, platform: process.platform },
        })
        throw err
      }
      chromePid = browserProcess.pid

      browserProcess.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })

      const childProcess = browserProcess
      earlyExitPromise = new Promise<never>((_, reject) => {
        childProcess.on('error', (err) => {
          console.error(`[ChromeProvider] Browser process error for instance ${instanceId}:`, err)
          const stderr = Buffer.concat(stderrChunks).toString().trim()
          reject(new Error(
            `Failed to spawn browser: ${err.message}${stderr ? `\nChrome stderr: ${stderr}` : ''}`
          ))
        })
        childProcess.on('exit', (code, signal) => {
          earlyExitCode = code
          earlyExitSignal = signal
          const stderr = Buffer.concat(stderrChunks).toString().trim()
          reject(new Error(
            `Browser process exited with ${signal ? `signal ${signal}` : `code ${code}`} before debug port became available` +
            (stderr ? `\nChrome stderr: ${stderr}` : '')
          ))
        })
      })
    }

    // Expose Chrome's loopback CDP port to the agent container. Some runners
    // route containers to the host through a real bridge-gateway interface
    // (Lima vmnet, WSL2/nerdctl, native Docker/Podman bridge) rather than the
    // host's loopback, so those containers cannot reach 127.0.0.1 on the host.
    // For them we run a lightweight TCP proxy that forwards to Chrome's loopback
    // CDP port. (On Windows, Chrome also always binds CDP to 127.0.0.1 and
    // ignores --remote-debugging-address, so the proxy is required there too.)
    //
    // SECURITY: the proxy binds ONLY that single host-internal bridge interface,
    // never 0.0.0.0 — CDP is unauthenticated, so an all-interfaces bind would
    // hand full browser control to anything on the LAN. Loopback-forwarding
    // runners (Docker Desktop) report no bridge IP, so we skip the proxy and the
    // container reaches Chrome's loopback port directly.
    let proxyPort: number | null = null
    let proxyServer: net.Server | null = null
    let proxyHost: string | null = null
    const bridgeIp = this.getHostBridgeIp(instanceId)
    if (bridgeIp) {
      try {
        proxyPort = await this.findFreePort()
        proxyHost = bridgeIp
        proxyServer = net.createServer((client) => {
          const target = net.connect(port, CDP_LOOPBACK_ADDRESS)
          client.pipe(target)
          target.pipe(client)
          client.on('error', () => target.destroy())
          target.on('error', () => client.destroy())
        })
        await new Promise<void>((resolve, reject) => {
          proxyServer!.listen(proxyPort!, proxyHost!, () => resolve())
          proxyServer!.on('error', reject)
        })
      } catch (err) {
        // Chrome is already spawned but the instance isn't registered yet, so the
        // normal stop()/exit cleanup can't reach it. Tear down the half-open proxy
        // and the orphaned browser before failing the launch. Killing Chrome makes
        // earlyExitPromise reject, but the launch race that would consume it hasn't
        // started — attach a no-op catch so that rejection isn't left unhandled.
        earlyExitPromise.catch(() => {})
        proxyServer?.close()
        this.killSpawnedChrome(browserProcess, chromePid)
        throw new Error(
          `Failed to bind host-browser CDP proxy on ${bridgeIp}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    const instance: BrowserInstance = {
      process: browserProcess,
      pid: chromePid,
      port,
      proxyPort,
      proxyServer,
      userDataDir,
      stoppingIntentionally: false,
      externalCloseWatcher: null,
    }
    this.instances.set(instanceId, instance)

    // Wire up external-close detection. On linux/win32 we have a real ChildProcess
    // and can use its 'exit' event. On darwin Chrome was launched via `open` and
    // is reparented to launchd, so we poll the PID instead.
    const handleExit = (reason: string) => {
      console.log(`[ChromeProvider] Browser for instance ${instanceId} exited (${reason})`)
      const wasIntentional = instance.stoppingIntentionally
      instance.proxyServer?.close()
      if (instance.externalCloseWatcher) {
        clearInterval(instance.externalCloseWatcher)
        instance.externalCloseWatcher = null
      }
      this.instances.delete(instanceId)
      if (!wasIntentional) {
        console.log(`[ChromeProvider] Browser for instance ${instanceId} closed externally, notifying listeners`)
        Promise.resolve(this.onExternalClose?.(instanceId)).catch((err) => {
          console.error('[ChromeProvider] Error in onExternalClose callback:', err)
        })
      }
    }

    if (browserProcess) {
      browserProcess.on('exit', (code) => handleExit(`code ${code}`))
    }
    // The darwin polling watcher is started after the launch race succeeds,
    // so it doesn't fight with earlyExitInterval.

    try {
      // Race the port check against early process death / spawn errors.
      // If Chrome crashes or fails to spawn, we get an immediate error
      // instead of waiting the full 15s timeout.
      await Promise.race([
        this.waitForPort(port, 15000, () => earlyExitCode, () => Buffer.concat(stderrChunks).toString().trim()),
        earlyExitPromise,
      ])
    } catch (err) {
      if (earlyExitInterval) { clearInterval(earlyExitInterval); earlyExitInterval = null }
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
          earlyExitSignal,
          timeToExitMs: earlyExitCode !== undefined ? Date.now() - spawnedAt : null,
          stderr: stderr.slice(-2000),
          crashReport: collectRecentCrashReport(),
          userDataDir,
          profileId,
          spawnArgs: [
            `--remote-debugging-port=${port}`,
            `--remote-debugging-address=${CDP_LOOPBACK_ADDRESS}`,
            `--user-data-dir=${userDataDir}`,
          ],
          ...diagnostics,
        },
      })
      await this.stop(instanceId)
      throw err
    }

    // Launch race won. Stop the early-exit poller (if any) and, on darwin,
    // start a long-lived poller to detect external close (Chrome quit by user).
    if (earlyExitInterval) { clearInterval(earlyExitInterval); earlyExitInterval = null }
    if (!browserProcess) {
      // darwin path: poll the PID at 1s intervals
      instance.externalCloseWatcher = setInterval(() => {
        try {
          process.kill(chromePid, 0)
        } catch {
          handleExit(`PID ${chromePid} no longer alive`)
        }
      }, 1000)
    }

    const exposedPort = proxyPort ?? port

    console.log(`[ChromeProvider] Chrome CDP on ${CDP_LOOPBACK_ADDRESS}:${port}${proxyPort ? `, proxy on ${proxyHost}:${proxyPort}` : ''} for instance ${instanceId} (pid ${chromePid})`)
    return { port: exposedPort, downloadDir }
  }

  async stop(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId)
    if (instance) {
      instance.stoppingIntentionally = true
      instance.proxyServer?.close()
      if (instance.externalCloseWatcher) {
        clearInterval(instance.externalCloseWatcher)
        instance.externalCloseWatcher = null
      }

      if (instance.process && !instance.process.killed) {
        // linux/win32: we own the child process. Kill via the ChildProcess
        // and wait for the 'exit' event so the next launch() doesn't race
        // with a still-dying Chrome.
        const childProcess = instance.process
        childProcess.kill()
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            try { childProcess.kill('SIGKILL') } catch { /* ignore */ }
            resolve()
          }, 5000)
          childProcess.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        })
      } else if (!instance.process) {
        // darwin: Chrome was reparented to launchd. Send SIGTERM by PID and
        // poll for exit, escalating to SIGKILL if it doesn't exit in time.
        try {
          process.kill(instance.pid, 'SIGTERM')
        } catch { /* already gone */ }
        await this.waitForPidExit(instance.pid, 5000)
        if (await this.pidAlive(instance.pid)) {
          try { process.kill(instance.pid, 'SIGKILL') } catch { /* ignore */ }
          await this.waitForPidExit(instance.pid, 2000)
        }
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
      if (!instance) return false
      // linux/win32: check the ChildProcess; darwin: check the PID directly.
      if (instance.process) return !instance.process.killed
      try {
        process.kill(instance.pid, 0)
        return true
      } catch {
        return false
      }
    }
    return this.instances.size > 0
  }

  /** Locate the Chrome browser-process PID for a given user-data-dir.
   *  Chrome spawns helper processes (renderer, GPU, utility); we want the parent,
   *  which is the one whose argv contains --user-data-dir=<dir> AND no --type= flag.
   *  Retries until found or the timeout elapses, since `open` returns before
   *  Chrome's processes are visible to ps. */
  private async findChromePidByUserDataDir(userDataDir: string, timeoutMs: number): Promise<number | null> {
    const needle = `--user-data-dir=${userDataDir}`
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const out = execSync('ps -A -o pid=,command=', { encoding: 'utf-8', timeout: 3000 })
        for (const line of out.split('\n')) {
          if (!line.includes(needle)) continue
          if (line.includes('--type=')) continue // helper process
          const m = line.trim().match(/^(\d+)\s/)
          if (m) return parseInt(m[1], 10)
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  private getChromeVersion(): string | null {
    if (!this.detectedPath) return null
    try {
      if (process.platform === 'darwin') {
        const plistPath = path.join(path.dirname(this.detectedPath), '..', 'Info.plist')
        const plist = fs.readFileSync(plistPath, 'utf-8')
        const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
        return m?.[1] ?? null
      }
      if (process.platform === 'win32') {
        return execSync(`"${this.detectedPath}" --version 2>nul`, { encoding: 'utf-8', timeout: 5000 }).trim().replace(/^Google Chrome\s+/, '')
      }
      return execSync(`"${this.detectedPath}" --version 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim().replace(/^Google Chrome\s+/, '')
    } catch { return null }
  }

  private async pidAlive(pid: number): Promise<boolean> {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  private async waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await this.pidAlive(pid))) return
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * The host interface IP to bind the CDP forwarding proxy to, or null to skip
   * the proxy and let the container reach Chrome's loopback CDP port directly.
   *
   * The active runner reports the gateway its containers use to reach the host
   * (this same value feeds `--add-host host.docker.internal`). But we can only
   * bind a proxy there if that gateway is an address THIS host actually has an
   * interface for:
   *   - socket_vmnet/shared bridges, WSL2's vEthernet, docker0 → a real, bindable
   *     host interface that does NOT forward loopback → bind the proxy there.
   *   - Lima's user-mode / VZ-NAT networking (the bundled default) → the gateway
   *     (e.g. 192.168.5.2) is virtual (gvproxy/VZ framework, not a host interface),
   *     so binding it throws EADDRNOTAVAIL. It also needs no proxy: that mode
   *     forwards the gateway to the host's loopback, so the container reaches
   *     Chrome's 127.0.0.1 CDP directly — exactly how it already reaches
   *     HOST_APP_URL. Like Docker Desktop, return null here.
   */
  /** Best-effort teardown of a Chrome that was spawned but not yet registered
   *  (e.g. the CDP proxy failed to bind), so it isn't orphaned. */
  private killSpawnedChrome(proc: ChildProcess | null, pid: number): void {
    try {
      if (proc && !proc.killed) proc.kill()
      else if (pid > 0) process.kill(pid)
    } catch {
      /* already gone */
    }
  }

  private getHostBridgeIp(instanceId: string): string | null {
    let ip: string | null = null
    try {
      ip = containerManager.getClient(instanceId).getHostBridgeIp()
    } catch (error) {
      console.warn('[ChromeProvider] Could not resolve host bridge IP for CDP proxy:', error)
      return null
    }
    if (!ip) return null
    if (!isLocalInterfaceAddress(ip)) {
      console.log(
        `[ChromeProvider] CDP: bridge IP ${ip} is not a bindable host interface ` +
        `(user-mode networking forwards it to host loopback); using loopback-direct, no proxy`
      )
      return null
    }
    return ip
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

  private async waitForPort(port: number, timeoutMs: number, getExitCode?: () => number | null | undefined, getStderr?: () => string): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // If the process already exited, no point waiting for the port
      const exitCode = getExitCode?.()
      if (exitCode !== undefined) {
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
