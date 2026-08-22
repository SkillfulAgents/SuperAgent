import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { captureDashboardScreenshot, type ScreenshotResult } from './dashboard-screenshot'
import { notifyDashboardScreenshotReady, notifyDashboardStatusChanged } from './host-events'
import { DashboardPackageSchema } from './dashboard-package-schema'

const SCREENSHOT_FILENAME = 'screenshot.png'

// Env override exists so tests can point the manager at a temp directory.
export const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/workspace/artifacts'
const DASHBOARD_BASE_PORT = 5000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
// Boot screenshots spawn a Chromium per dashboard; deferring them keeps the
// container's few CPUs free for dashboard/server startup while users wait.
const BOOT_SCREENSHOT_DELAY_MS = 10_000
// Bun defaults to 48 concurrent network requests. Under Lima's virtualized
// network that causes small package downloads to stall in long waves; eight
// keeps the pipeline full without overwhelming the VM's network path.
export const BUN_INSTALL_NETWORK_CONCURRENCY = 8
export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

// dashboard.log is append-only across every start/crash/restart; without a
// cap a chatty or crash-looping dashboard grows it forever.
export const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024
export const LOG_TAIL_KEEP_BYTES = 256 * 1024

/**
 * If the log exceeds `maxBytes`, rewrite it to a marker line plus the last
 * `keepBytes` of content (the recent output is what debugging needs).
 * Only call while no stream has the file open for append.
 * @returns true if the file was truncated
 */
export async function truncateOversizedLog(
  logPath: string,
  maxBytes: number = MAX_LOG_SIZE_BYTES,
  keepBytes: number = LOG_TAIL_KEEP_BYTES
): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(logPath)
    if (stat.size <= maxBytes) return false

    const fd = await fs.promises.open(logPath, 'r')
    let tail: Buffer
    try {
      const buf = Buffer.alloc(Math.min(keepBytes, stat.size))
      const { bytesRead } = await fd.read(buf, 0, buf.length, stat.size - buf.length)
      tail = buf.subarray(0, bytesRead)
    } finally {
      await fd.close()
    }

    await fs.promises.writeFile(
      logPath,
      Buffer.concat([
        Buffer.from(`[DashboardManager] Log truncated from ${stat.size} bytes, keeping the last ${tail.length}\n`),
        tail,
      ])
    )
    return true
  } catch {
    // ENOENT (no log yet) or a read/write failure — leave the file alone
    return false
  }
}

// Start scripts the react-vite template has shipped with (current and legacy).
// Both reduce to "ensure dist is built, then run serve.js", so the boot path
// may substitute `bun run serve.js` directly when the build output is fresh
// (see canSkipTemplateBuild) — that also skips the wrapper-script spawn chain.
// Matched by exact equality — any customized start script (extra steps,
// different server) always runs as written.
export const TEMPLATE_BUILD_AND_SERVE_STARTS: ReadonlySet<string> = new Set([
  'bun run build-if-needed.js && bun run serve.js',
  'bun run build && bun run serve.js',
])

// Safety bound for the freshness walk; a dashboard tree bigger than this
// rebuilds rather than risk an incomplete scan.
const FRESHNESS_WALK_MAX_ENTRIES = 2000

// Build inputs/outputs the freshness walk must not treat as sources.
const FRESHNESS_WALK_EXCLUDES = new Set([
  'node_modules',
  'dist',
  'dashboard.log',
  SCREENSHOT_FILENAME,
  'bun.lock',
  'bun.lockb',
])

/**
 * Newest mtime (ms) of any file under `dir`, skipping `excludes` at every
 * level. Returns null when the walk exceeds `maxEntries` (caller must treat
 * that as "unknown → stale") or the directory is unreadable.
 */
export function newestMtimeMs(
  dir: string,
  excludes: ReadonlySet<string> = FRESHNESS_WALK_EXCLUDES,
  maxEntries: number = FRESHNESS_WALK_MAX_ENTRIES,
): number | null {
  let newest = 0
  let seen = 0
  const stack = [dir]
  try {
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (excludes.has(entry.name)) continue
        if (++seen > maxEntries) return null
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile()) {
          const mtime = fs.statSync(full).mtimeMs
          if (mtime > newest) newest = mtime
        }
      }
    }
  } catch {
    return null
  }
  return newest
}

export function validateSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(`Invalid dashboard slug: "${slug}". Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen.`)
  }
  // Belt-and-suspenders: verify resolved path stays within ARTIFACTS_DIR
  const resolved = path.resolve(ARTIFACTS_DIR, slug)
  if (!resolved.startsWith(ARTIFACTS_DIR + '/')) {
    throw new Error(`Invalid dashboard slug: "${slug}". Path traversal detected.`)
  }
}

/**
 * Browser-visible mount supplied to framework build/dev tooling.
 *
 * The agent id is injected by the host when the container starts. Dashboards
 * still work without it (for direct development and older hosts), but only a
 * host-provided id can form the public Gamut path without hardcoding it in the
 * dashboard itself.
 */
export function getDashboardBasePath(
  slug: string,
  agentId: string | undefined = process.env.SUPERAGENT_AGENT_SLUG
    || process.env.SUPERAGENT_AGENT_ID,
): string | null {
  validateSlug(slug)
  const normalizedAgentId = agentId?.trim()
  if (!normalizedAgentId || !/^[A-Za-z0-9._-]+$/.test(normalizedAgentId)) return null
  return `/api/agents/${encodeURIComponent(normalizedAgentId)}/artifacts/${slug}/`
}

export type DashboardStatus = 'running' | 'stopped' | 'crashed' | 'starting'
export type DashboardStartupPhase = 'installing-dependencies' | 'starting-server'
export type DashboardUpstreamPathMode = 'stripped' | 'mounted'

export function getDashboardValidationUrl(
  slug: string,
  port: number,
  mode: DashboardUpstreamPathMode,
  agentId?: string,
): string {
  const pathname = mode === 'mounted' ? (getDashboardBasePath(slug, agentId) ?? '/') : '/'
  return `http://localhost:${port}${pathname}`
}

interface DashboardInfo {
  slug: string
  name: string
  description: string
  upstreamPathMode: DashboardUpstreamPathMode
  port: number
  status: DashboardStatus
  startupPhase: DashboardStartupPhase
  firstRun: boolean
  process: ChildProcess | null
  restartCount: number
  restartTimestamps: number[]
  logStream: fs.WriteStream | null
}

class DashboardManager {
  private dashboards: Map<string, DashboardInfo> = new Map()
  private nextPort = DASHBOARD_BASE_PORT

  /**
   * End a dashboard's log stream exactly once. Nulls the field BEFORE ending:
   * a second end() on a finished WriteStream emits ERR_STREAM_ALREADY_FINISHED,
   * which would be an uncaught exception. Every close site must go through
   * this — the process 'close' handler, stop paths, and restarts can overlap.
   */
  private closeLogStream(info: DashboardInfo): void {
    const stream = info.logStream
    info.logStream = null
    stream?.end()
  }

  /**
   * Push a terminal startup transition to the host (best-effort — the
   * renderer's artifacts poll remains the fallback for a missed event).
   */
  private publishStatus(slug: string, status: 'running' | 'crashed'): void {
    void notifyDashboardStatusChanged(slug, status).catch((error) => {
      console.warn(`[DashboardManager] Failed to publish ${status} event for ${slug}:`, error)
    })
  }

  async scanAndStartAll(): Promise<void> {
    try {
      await fs.promises.mkdir(ARTIFACTS_DIR, { recursive: true })
      const entries = await fs.promises.readdir(ARTIFACTS_DIR, { withFileTypes: true })

      const started: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const pkgPath = path.join(ARTIFACTS_DIR, entry.name, 'package.json')
        try {
          await fs.promises.access(pkgPath)
          // Boot scan trusts the node_modules freshness heuristic — deps only
          // change through agent-initiated starts, which force an install.
          const info = await this.startDashboard(entry.name, { forceInstall: false })
          if (info.status === 'running') started.push(entry.name)
        } catch {
          // No package.json, skip
        }
      }

      // Refresh screenshots only after the boot storm settles: each capture
      // spawns a Chromium, and doing that while dashboards (and the session
      // prewarm) are still starting starves them of CPU exactly when a user
      // is waiting for first paint. Sequential on purpose — one Chromium at
      // a time.
      if (started.length > 0) {
        setTimeout(() => {
          void (async () => {
            for (const slug of started) {
              if (this.dashboards.get(slug)?.status !== 'running') continue
              await this.captureScreenshot(slug).catch((err) => {
                console.warn(`[DashboardManager] Boot screenshot failed for ${slug}:`, err)
              })
            }
          })()
        }, BOOT_SCREENSHOT_DELAY_MS)
      }
    } catch (error) {
      console.error('[DashboardManager] Error scanning artifacts:', error)
    }
  }

  /**
   * Capture a screenshot of a running dashboard and write it to
   * <artifactDir>/screenshot.png. Best-effort — returns the result so callers
   * can decide what to do, but never throws.
   */
  async captureScreenshot(slug: string): Promise<ScreenshotResult> {
    const info = this.dashboards.get(slug)
    if (!info || info.status !== 'running') {
      return { ok: false, reason: `Dashboard ${slug} is not running` }
    }
    const outPath = path.join(ARTIFACTS_DIR, slug, SCREENSHOT_FILENAME)
    const url = getDashboardValidationUrl(slug, info.port, info.upstreamPathMode)
    const result = await captureDashboardScreenshot(url, outPath)
    if (result.ok) {
      void notifyDashboardScreenshotReady(slug).catch((error) => {
        console.warn(`[DashboardManager] Failed to publish screenshot event for ${slug}:`, error)
      })
    }
    return result
  }

  private readPackageJson(slug: string): {
    name: string
    description: string
    upstreamPathMode: DashboardUpstreamPathMode
  } {
    try {
      const pkgPath = path.join(ARTIFACTS_DIR, slug, 'package.json')
      const pkg = DashboardPackageSchema.parse(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')))
      return {
        name: pkg.name || slug,
        description: pkg.description || '',
        upstreamPathMode: pkg.gamut?.upstreamPath === 'mounted' ? 'mounted' : 'stripped',
      }
    } catch (error) {
      console.warn(
        `[DashboardManager] Invalid package.json metadata for ${slug}; using safe defaults:`,
        error,
      )
      return { name: slug, description: '', upstreamPathMode: 'stripped' }
    }
  }

  /**
   * `forceInstall` (default true) always runs `bun install` before starting,
   * so an agent-edited package.json takes effect even when the node_modules
   * freshness heuristic would skip it. Internal boot/crash-restart paths pass
   * false — deps can't have changed there, and skipping keeps boot fast.
   */
  async startDashboard(
    slug: string,
    opts?: { forceInstall?: boolean }
  ): Promise<DashboardInfo> {
    const forceInstall = opts?.forceInstall ?? true
    validateSlug(slug)
    const existing = this.dashboards.get(slug)

    // If already running, kill and restart
    if (existing?.process && existing.status === 'running') {
      existing.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        if (existing.process) {
          existing.process.on('exit', () => resolve())
          setTimeout(resolve, 5000) // Force timeout
        } else {
          resolve()
        }
      })
      this.closeLogStream(existing)
    }

    const { name, description, upstreamPathMode } = this.readPackageJson(slug)
    const port = existing?.port ?? this.nextPort++
    const dashboardDir = path.join(ARTIFACTS_DIR, slug)
    const logPath = path.join(dashboardDir, 'dashboard.log')
    const firstRun = !fs.existsSync(path.join(dashboardDir, 'node_modules'))

    const info: DashboardInfo = {
      slug,
      name,
      description,
      upstreamPathMode,
      port,
      status: 'starting',
      startupPhase: 'starting-server',
      firstRun,
      process: null,
      restartCount: existing?.restartCount ?? 0,
      restartTimestamps: existing?.restartTimestamps ?? [],
      logStream: null,
    }

    this.dashboards.set(slug, info)

    try {
      // Bound the append-only log before reopening it
      await truncateOversizedLog(logPath)

      // Open log stream early so install errors are captured
      info.logStream = fs.createWriteStream(logPath, { flags: 'a' })
      // A write failure (e.g. ENOSPC) must not take down the server — a
      // WriteStream 'error' with no listener throws as an uncaught exception.
      info.logStream.on('error', (error) => {
        console.error(`[DashboardManager] Log stream error for ${slug}:`, error)
      })

      // Run bun install: always when forced (deps may have changed), else
      // only if node_modules is missing or package.json is newer than it
      await this.runBunInstallIfNeeded(
        dashboardDir,
        info.logStream,
        forceInstall,
        () => { info.startupPhase = 'installing-dependencies' },
      )

      // Start the dashboard server
      info.startupPhase = 'starting-server'
      const dashboardBasePath = getDashboardBasePath(slug)
      // Boot/crash-restart path: sources only change through agent-initiated
      // starts (which pass forceInstall and always run the full start script),
      // so a fresh dist/ can serve directly and skip the template's
      // unconditional Vite rebuild.
      const skipBuild = !forceInstall && this.canSkipTemplateBuild(dashboardDir)
      if (skipBuild) {
        info.logStream?.write('[DashboardManager] dist up-to-date, skipping build (bun run serve.js)\n')
      }
      const proc = spawn('bun', skipBuild ? ['run', 'serve.js'] : ['run', 'start'], {
        cwd: dashboardDir,
        env: {
          ...process.env,
          DASHBOARD_PORT: String(port),
          ...(dashboardBasePath ? { DASHBOARD_BASE_PATH: dashboardBasePath } : {}),
          DASHBOARD_ARTIFACT_SLUG: slug,
          PORT: String(port),
          NODE_ENV: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      info.process = proc

      proc.stdout?.pipe(info.logStream, { end: false })
      proc.stderr?.pipe(info.logStream, { end: false })

      proc.on('exit', (code, signal) => {
        console.log(`[DashboardManager] Dashboard ${slug} exited (code=${code}, signal=${signal})`)
        info.status = 'stopped'
        info.process = null

        if (code !== 0 && signal !== 'SIGTERM') {
          this.handleCrash(slug)
        }
      })

      // 'close' (not 'exit') is when stdout/stderr have finished flushing into
      // the log, so ending here can't drop the process's final output. Without
      // this, every exit leaked the stream's fd — a crash-looping dashboard
      // accumulated them until EMFILE.
      proc.on('close', () => {
        this.closeLogStream(info)
      })

      proc.on('error', (error) => {
        console.error(`[DashboardManager] Dashboard ${slug} process error:`, error)
        info.logStream?.write(`[process error] ${error.message}\n`)
        info.status = 'crashed'
        info.process = null
        this.publishStatus(slug, 'crashed')
        // On spawn failure 'close' isn't guaranteed — close here too (no-op if
        // the 'close' handler already ran).
        this.closeLogStream(info)
      })

      console.log(`[DashboardManager] Starting dashboard ${slug} on port ${port}, waiting for port...`)

      // Wait for the server to actually be listening on the port
      const ready = await this.waitForPort(port, 30000)
      if (ready && info.status === 'starting') {
        info.status = 'running'
        console.log(`[DashboardManager] Dashboard ${slug} is now running on port ${port}`)
        this.publishStatus(slug, 'running')
      } else if (info.status === 'starting') {
        // Timed out waiting for port — process may be slow or broken
        console.error(`[DashboardManager] Dashboard ${slug} did not become ready in time`)
        info.logStream?.write(`[DashboardManager] Timed out waiting for port ${port} to be ready\n`)
        info.status = 'crashed'
        if (info.process) {
          info.process.kill('SIGTERM')
          info.process = null
        }
        this.publishStatus(slug, 'crashed')
      }
    } catch (error: any) {
      console.error(`[DashboardManager] Failed to start dashboard ${slug}:`, error)
      info.logStream?.write(`[DashboardManager] Failed to start: ${error?.message || error}\n`)
      this.closeLogStream(info)
      info.status = 'crashed'
      this.publishStatus(slug, 'crashed')
    }

    return info
  }

  private async runBunInstallIfNeeded(
    dir: string,
    logStream: fs.WriteStream | undefined,
    force: boolean,
    onInstallStart: () => void,
  ): Promise<void> {
    if (!force) {
      const nodeModules = path.join(dir, 'node_modules')
      const pkgJson = path.join(dir, 'package.json')
      try {
        const nmStat = fs.statSync(nodeModules)
        const pkgStat = fs.statSync(pkgJson)
        if (nmStat.isDirectory() && nmStat.mtimeMs >= pkgStat.mtimeMs) {
          logStream?.write('[DashboardManager] node_modules up-to-date, skipping bun install\n')
          return
        }
      } catch {
        // node_modules doesn't exist or stat failed — need install
      }
      // Boot-path install with a lockfile present: try --frozen-lockfile first
      // so the install is resolution-free and deterministic. If the lockfile
      // is out of sync with package.json, fall back to a plain install.
      onInstallStart()
      if (this.hasLockfile(dir)) {
        try {
          return await this.runBunInstall(dir, logStream, ['--frozen-lockfile'])
        } catch {
          logStream?.write('[DashboardManager] frozen-lockfile install failed, retrying without\n')
        }
      }
    } else {
      onInstallStart()
    }
    // Forced (agent-initiated) or no/stale lockfile: plain install, which
    // resolves and updates the lockfile as needed.
    return this.runBunInstall(dir, logStream)
  }

  /**
   * True when this dashboard uses the stock template start script
   * (`build && serve`) verbatim AND its build output is at least as new as
   * every source file — in which case `bun run serve.js` is equivalent to
   * `bun run start` minus the rebuild. Any doubt (custom start script, missing
   * dist, unreadable tree, oversized tree) returns false and the full start
   * script runs.
   */
  private canSkipTemplateBuild(dir: string): boolean {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
      if (!TEMPLATE_BUILD_AND_SERVE_STARTS.has(pkg?.scripts?.start)) return false
      if (!fs.existsSync(path.join(dir, 'serve.js'))) return false
      const distStamp = newestMtimeMs(path.join(dir, 'dist'), new Set())
      if (distStamp === null || distStamp === 0) return false
      const sourceStamp = newestMtimeMs(dir)
      if (sourceStamp === null) return false
      return sourceStamp <= distStamp
    } catch {
      return false
    }
  }

  private hasLockfile(dir: string): boolean {
    return (
      fs.existsSync(path.join(dir, 'bun.lock')) ||
      fs.existsSync(path.join(dir, 'bun.lockb'))
    )
  }

  private async runBunInstall(
    dir: string,
    logStream?: fs.WriteStream,
    extraArgs: string[] = []
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'bun',
        ['install', `--network-concurrency=${BUN_INSTALL_NETWORK_CONCURRENCY}`, ...extraArgs],
        {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )

      let stderr = ''
      proc.stdout?.on('data', (chunk) => {
        logStream?.write(chunk)
      })
      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
        logStream?.write(chunk)
      })

      proc.on('exit', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`bun install failed (code ${code}): ${stderr}`))
        }
      })

      proc.on('error', (err) => {
        logStream?.write(`[bun install error] ${err.message}\n`)
        reject(err)
      })
    })
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    const interval = 100
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`http://localhost:${port}/`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(1000),
        })
        // Any response (even 404) means the server is listening
        if (response) return true
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    return false
  }

  private handleCrash(slug: string): void {
    const info = this.dashboards.get(slug)
    if (!info) return

    const now = Date.now()
    // Prune old timestamps outside the window
    info.restartTimestamps = info.restartTimestamps.filter(
      (ts) => now - ts < RESTART_WINDOW_MS
    )

    if (info.restartTimestamps.length >= MAX_RESTARTS) {
      console.log(`[DashboardManager] Dashboard ${slug} exhausted restart attempts`)
      info.status = 'crashed'
      this.publishStatus(slug, 'crashed')
      return
    }

    info.restartTimestamps.push(now)
    info.restartCount++
    console.log(`[DashboardManager] Auto-restarting dashboard ${slug} (attempt ${info.restartTimestamps.length}/${MAX_RESTARTS})`)

    // Delay restart slightly. Deps can't have changed across a crash — skip
    // the forced install.
    setTimeout(() => {
      this.startDashboard(slug, { forceInstall: false }).catch((err) => {
        console.error(`[DashboardManager] Failed to restart dashboard ${slug}:`, err)
      })
    }, 1000)
  }

  listDashboards(): Array<{
    slug: string
    name: string
    description: string
    status: DashboardStatus
    port: number
    startupPhase?: DashboardStartupPhase
    firstRun?: boolean
  }> {
    const result: Array<{
      slug: string
      name: string
      description: string
      status: DashboardStatus
      port: number
      startupPhase?: DashboardStartupPhase
      firstRun?: boolean
    }> = []

    // Include tracked dashboards
    for (const info of this.dashboards.values()) {
      result.push({
        slug: info.slug,
        name: info.name,
        description: info.description,
        status: info.status,
        port: info.port,
        ...(info.status === 'starting'
          ? { startupPhase: info.startupPhase, firstRun: info.firstRun }
          : {}),
      })
    }

    // Also scan for untracked dashboards (created but never started)
    try {
      const entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (this.dashboards.has(entry.name)) continue

        const pkgPath = path.join(ARTIFACTS_DIR, entry.name, 'package.json')
        try {
          fs.accessSync(pkgPath)
          const { name, description } = this.readPackageJson(entry.name)
          result.push({
            slug: entry.name,
            name,
            description,
            status: 'stopped',
            port: 0,
          })
        } catch {
          // No package.json, skip
        }
      }
    } catch {
      // artifacts dir may not exist yet
    }

    return result
  }

  async stopDashboard(slug: string): Promise<boolean> {
    const info = this.dashboards.get(slug)
    if (!info) return false

    if (info.process) {
      info.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        if (info.process) {
          info.process.on('exit', () => resolve())
          setTimeout(resolve, 5000)
        } else {
          resolve()
        }
      })
    }

    this.closeLogStream(info)
    this.dashboards.delete(slug)
    return true
  }

  getDashboardPort(slug: string): number | null {
    const info = this.dashboards.get(slug)
    if (!info || info.status !== 'running') return null
    return info.port
  }

  getDashboardStatus(slug: string): DashboardStatus | null {
    return this.dashboards.get(slug)?.status ?? null
  }

  /**
   * Resolve once a 'starting' dashboard reaches a terminal outcome (or the
   * bound elapses). Lets the proxy hold an early document request instead of
   * answering 503 — an optimistically-mounted iframe then paints the moment
   * the server binds. Returns immediately for any non-'starting' status.
   */
  async waitForStartupOutcome(slug: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.dashboards.get(slug)?.status === 'starting') {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  getDashboardUpstreamPathMode(slug: string): DashboardUpstreamPathMode {
    return this.dashboards.get(slug)?.upstreamPathMode ?? 'stripped'
  }

  async getDashboardLogs(slug: string, clear: boolean = false): Promise<string> {
    validateSlug(slug)
    const logPath = path.join(ARTIFACTS_DIR, slug, 'dashboard.log')

    try {
      const content = await fs.promises.readFile(logPath, 'utf-8')

      if (clear) {
        await fs.promises.writeFile(logPath, '')
      }

      return content
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return ''
      }
      throw error
    }
  }

  async createDashboard(
    slug: string,
    name: string,
    description: string,
    framework: 'plain' | 'react' = 'plain'
  ): Promise<void> {
    validateSlug(slug)
    const dir = path.join(ARTIFACTS_DIR, slug)

    // Check if dashboard already exists
    try {
      await fs.promises.access(path.join(dir, 'package.json'))
      throw new Error(`Dashboard "${slug}" already exists. Use a different slug or delete the existing dashboard first.`)
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
    }

    await fs.promises.mkdir(dir, { recursive: true })

    if (framework === 'react') {
      await this.scaffoldReactDashboard(dir, name, description)
    } else {
      await this.scaffoldPlainDashboard(dir, name, description)
    }
  }

  private async scaffoldPlainDashboard(
    dir: string,
    name: string,
    description: string
  ): Promise<void> {
    const pkg = {
      name,
      description,
      scripts: {
        start: 'bun run index.js',
      },
      dependencies: {},
    }

    await fs.promises.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(pkg, null, 2)
    )

    const indexJs = `const port = process.env.DASHBOARD_PORT || 3000;

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

const html = \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #333; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <p>${description || 'Dashboard is running.'}</p>
</body>
</html>\`;

console.log(\`Dashboard server running on http://localhost:\${port}\`);
`

    await fs.promises.writeFile(path.join(dir, 'index.js'), indexJs)
  }

  private async scaffoldReactDashboard(
    dir: string,
    name: string,
    description: string
  ): Promise<void> {
    const templateDir = path.join(
      process.env.HOME || '/home/claude',
      '.claude/skills/dashboards/templates/react-vite'
    )

    // Copy template directory recursively
    await fs.promises.cp(templateDir, dir, { recursive: true })

    // Update package.json with the dashboard's name and description
    const pkgPath = path.join(dir, 'package.json')
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf-8'))
    pkg.name = name
    pkg.description = description
    await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  }

  async stopAll(): Promise<void> {
    for (const info of this.dashboards.values()) {
      if (info.process) {
        info.process.kill('SIGTERM')
      }
      // The stream can outlive the process (crashed dashboards keep it for a
      // final write) — close it regardless of process state.
      this.closeLogStream(info)
    }
    this.dashboards.clear()
  }
}

export const dashboardManager = new DashboardManager()
