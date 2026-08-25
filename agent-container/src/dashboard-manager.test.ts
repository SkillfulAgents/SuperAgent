import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  validateSlug,
  SLUG_REGEX,
  ARTIFACTS_DIR,
  getDashboardBasePath,
  getDashboardValidationUrl,
  truncateOversizedLog,
} from './dashboard-manager'

const spawnHolder = vi.hoisted(() => ({
  impl: null as ((command: string, args: string[], options: unknown) => unknown) | null,
}))
const screenshotMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  notifyReady: vi.fn(),
}))
const statusEventMock = vi.hoisted(() => vi.fn())

vi.mock('./dashboard-screenshot', () => ({
  captureDashboardScreenshot: (...args: unknown[]) => screenshotMocks.capture(...args),
}))

vi.mock('./host-events', () => ({
  notifyDashboardScreenshotReady: (...args: unknown[]) => screenshotMocks.notifyReady(...args),
  notifyDashboardStatusChanged: (...args: unknown[]) => statusEventMock(...args),
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: unknown) => {
      if (!spawnHolder.impl) throw new Error('spawn called before test set an impl')
      return spawnHolder.impl(command, args, options)
    },
  }
})

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn((signal?: string) => {
    setImmediate(() => this.exit(0, signal ?? 'SIGTERM'))
    return true
  })

  /** Simulate process termination: stdio flushes, then exit + close fire. */
  exit(code: number | null, signal: string | null = null) {
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

describe('validateSlug', () => {
  describe('valid slugs', () => {
    const valid = [
      'a',
      'x',
      'ab',
      'my-dashboard',
      'sales-dashboard-v2',
      'a1',
      '1a',
      '123',
      'abc',
      'my-long-dashboard-name-with-many-parts',
    ]

    for (const slug of valid) {
      it(`accepts "${slug}"`, () => {
        expect(() => validateSlug(slug)).not.toThrow()
      })
    }
  })

  describe('invalid slugs', () => {
    const invalid = [
      { slug: '', reason: 'empty string' },
      { slug: '-dashboard', reason: 'starts with hyphen' },
      { slug: 'dashboard-', reason: 'ends with hyphen' },
      { slug: '-', reason: 'just a hyphen' },
      { slug: 'My-Dashboard', reason: 'uppercase letters' },
      { slug: 'my_dashboard', reason: 'underscores' },
      { slug: 'my dashboard', reason: 'spaces' },
      { slug: 'my.dashboard', reason: 'dots' },
      { slug: '../etc', reason: 'path traversal with ..' },
      { slug: '../../etc/passwd', reason: 'deep path traversal' },
      { slug: 'foo/bar', reason: 'slashes' },
      { slug: 'foo\\bar', reason: 'backslashes' },
    ]

    for (const { slug, reason } of invalid) {
      it(`rejects "${slug}" (${reason})`, () => {
        expect(() => validateSlug(slug)).toThrow()
      })
    }
  })

  describe('path traversal defense', () => {
    it('regex alone blocks .. sequences', () => {
      expect(SLUG_REGEX.test('..')).toBe(false)
      expect(SLUG_REGEX.test('../foo')).toBe(false)
      expect(SLUG_REGEX.test('foo/../bar')).toBe(false)
    })

    it('regex blocks encoded traversal attempts', () => {
      // URL-encoded dots/slashes won't match [a-z0-9-]
      expect(SLUG_REGEX.test('%2e%2e')).toBe(false)
      expect(SLUG_REGEX.test('%2f')).toBe(false)
    })

    it('resolved path must stay within ARTIFACTS_DIR', () => {
      // Even if somehow a slug passes regex, the path check catches traversal
      const resolved = path.resolve(ARTIFACTS_DIR, '..', 'etc')
      expect(resolved.startsWith(ARTIFACTS_DIR + '/')).toBe(false)
    })
  })
})

describe('getDashboardBasePath', () => {
  it('builds the browser-visible artifact prefix from trusted startup identity', () => {
    expect(getDashboardBasePath('open-slide', 'agent-123')).toBe(
      '/api/agents/agent-123/artifacts/open-slide/',
    )
  })

  it('omits startup metadata when no valid agent identity is available', () => {
    expect(getDashboardBasePath('open-slide', '')).toBeNull()
    expect(getDashboardBasePath('open-slide', '../spoofed')).toBeNull()
  })
})

describe('getDashboardValidationUrl', () => {
  it('uses the local root for stripped dashboards', () => {
    expect(getDashboardValidationUrl('slides', 5000, 'stripped', 'agent-123')).toBe(
      'http://localhost:5000/',
    )
  })

  it('uses the public mount for mounted dashboards', () => {
    expect(getDashboardValidationUrl('slides', 5000, 'mounted', 'agent-123')).toBe(
      'http://localhost:5000/api/agents/agent-123/artifacts/slides/',
    )
  })
})

describe('truncateOversizedLog', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dashboard-log-'))
  })

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('leaves a log under the cap untouched', async () => {
    const logPath = path.join(testDir, 'dashboard.log')
    await fs.promises.writeFile(logPath, 'small log\n')

    expect(await truncateOversizedLog(logPath, 1024, 256)).toBe(false)
    expect(await fs.promises.readFile(logPath, 'utf-8')).toBe('small log\n')
  })

  it('keeps only the tail (plus a marker) of an oversized log', async () => {
    const logPath = path.join(testDir, 'dashboard.log')
    const content = 'x'.repeat(2000) + 'THE-TAIL'
    await fs.promises.writeFile(logPath, content)

    expect(await truncateOversizedLog(logPath, 1024, 256)).toBe(true)

    const after = await fs.promises.readFile(logPath, 'utf-8')
    expect(after).toMatch(/^\[DashboardManager\] Log truncated from 2008 bytes/)
    expect(after.endsWith('THE-TAIL')).toBe(true)
    // marker line + 256 tail bytes
    expect(after.length).toBeLessThan(256 + 120)
  })

  it('is a no-op for a missing file', async () => {
    expect(await truncateOversizedLog(path.join(testDir, 'nope.log'))).toBe(false)
  })
})

describe('DashboardManager log stream lifecycle', () => {
  let testDir: string
  let manager: {
    startDashboard(slug: string, opts?: { forceInstall?: boolean }): Promise<{
      status: string
      logStream: fs.WriteStream | null
      restartTimestamps: number[]
    }>
    stopDashboard(slug: string): Promise<boolean>
    stopAll(): Promise<void>
    getDashboardStatus(slug: string): string | null
    getDashboardPort(slug: string): number | null
    waitForStartupOutcome(slug: string, timeoutMs: number): Promise<void>
    getDashboardUpstreamPathMode(slug: string): 'stripped' | 'mounted'
    captureScreenshot(slug: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    listDashboards(): Array<{
      slug: string
      status: string
      startupPhase?: string
      firstRun?: boolean
    }>
  }
  let procs: FakeChildProcess[]
  let slugCounter = 0

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dashboard-manager-'))
    procs = []
    spawnHolder.impl = () => {
      const proc = new FakeChildProcess()
      procs.push(proc)
      return proc
    }

    // waitForPort probes the port over HTTP — pretend the server is up
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    screenshotMocks.capture.mockReset().mockResolvedValue({ ok: false, reason: 'not captured' })
    screenshotMocks.notifyReady.mockReset().mockResolvedValue(true)
    statusEventMock.mockReset().mockResolvedValue(true)

    // Fresh module (and singleton) pointed at the temp artifacts dir
    vi.resetModules()
    process.env.ARTIFACTS_DIR = testDir
    manager = (await import('./dashboard-manager')).dashboardManager
  })

  afterEach(async () => {
    await manager.stopAll()
    delete process.env.ARTIFACTS_DIR
    spawnHolder.impl = null
    vi.restoreAllMocks()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  /** Scaffold a dashboard dir whose node_modules is fresh (skips bun install). */
  async function scaffoldDashboard(packageFields: Record<string, unknown> = {}): Promise<string> {
    const slug = `dash-${++slugCounter}`
    const dir = path.join(testDir, slug)
    await fs.promises.mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await fs.promises.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: slug, scripts: { start: 'true' }, ...packageFields })
    )
    // node_modules must be at least as new as package.json to skip install
    const future = new Date(Date.now() + 60_000)
    await fs.promises.utimes(path.join(dir, 'node_modules'), future, future)
    return slug
  }

  it('publishes a precise host event after a dashboard screenshot succeeds', async () => {
    const slug = await scaffoldDashboard()
    await manager.startDashboard(slug, { forceInstall: false })
    const screenshotPath = path.join(testDir, slug, 'screenshot.png')
    screenshotMocks.capture.mockResolvedValueOnce({ ok: true, path: screenshotPath })

    await expect(manager.captureScreenshot(slug)).resolves.toEqual({ ok: true, path: screenshotPath })

    expect(screenshotMocks.notifyReady).toHaveBeenCalledWith(slug)
  })

  it('does not publish readiness when screenshot capture fails', async () => {
    const slug = await scaffoldDashboard()
    await manager.startDashboard(slug, { forceInstall: false })
    screenshotMocks.capture.mockResolvedValueOnce({ ok: false, reason: 'browser failed' })

    await expect(manager.captureScreenshot(slug)).resolves.toEqual({ ok: false, reason: 'browser failed' })

    expect(screenshotMocks.notifyReady).not.toHaveBeenCalled()
  })

  it('closes the log stream when the process exits cleanly', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug, { forceInstall: false })
    expect(info.status).toBe('running')
    const stream = info.logStream!
    expect(stream.writableEnded).toBe(false)

    procs[0].exit(0, null)

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
  })

  it('closes the log stream on the crash path', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug, { forceInstall: false })
    const stream = info.logStream!

    // Exhaust the restart budget so the crash doesn't schedule a restart
    info.restartTimestamps.push(Date.now(), Date.now(), Date.now())
    procs[0].exit(1, null)

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
    expect(info.status).toBe('crashed')
  })

  it('closes the log stream when the process errors without exiting', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug, { forceInstall: false })
    const stream = info.logStream!

    procs[0].emit('error', new Error('spawn ENOENT'))

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
    expect(info.status).toBe('crashed')
  })

  it('restart-while-running closes the old stream and opens a new one without double-end errors', async () => {
    const slug = await scaffoldDashboard()
    const first = await manager.startDashboard(slug, { forceInstall: false })
    const oldStream = first.logStream!

    // Restarting kills the old process; its exit ALSO triggers the close
    // handler — the old stream must end exactly once (a second end() would
    // throw ERR_STREAM_ALREADY_FINISHED as an uncaught exception).
    const second = await manager.startDashboard(slug, { forceInstall: false })

    expect(oldStream.writableEnded).toBe(true)
    expect(second.logStream).not.toBe(oldStream)
    expect(second.logStream!.writableEnded).toBe(false)
    expect(second.status).toBe('running')
  })

  it('stopDashboard ends the stream even though the close handler also ran', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug, { forceInstall: false })
    const stream = info.logStream!

    await manager.stopDashboard(slug)

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
  })

  it('truncates an oversized dashboard.log on start', async () => {
    const slug = await scaffoldDashboard()
    const logPath = path.join(testDir, slug, 'dashboard.log')
    await fs.promises.writeFile(logPath, Buffer.alloc(11 * 1024 * 1024, 0x61))

    await manager.startDashboard(slug, { forceInstall: false })

    const stat = await fs.promises.stat(logPath)
    expect(stat.size).toBeLessThan(1024 * 1024)
  })

  it('loads an explicit mounted upstream path contract from package metadata', async () => {
    const slug = await scaffoldDashboard({ gamut: { upstreamPath: 'mounted' } })

    await manager.startDashboard(slug, { forceInstall: false })

    expect(manager.getDashboardUpstreamPathMode(slug)).toBe('mounted')
  })

  it('defaults dashboards to the stripped upstream path contract', async () => {
    const slug = await scaffoldDashboard()

    await manager.startDashboard(slug, { forceInstall: false })

    expect(manager.getDashboardUpstreamPathMode(slug)).toBe('stripped')
  })

  it('warns and safely defaults an invalid upstream path mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slug = await scaffoldDashboard({ gamut: { upstreamPath: 'Mounted' } })

    await manager.startDashboard(slug, { forceInstall: false })

    expect(manager.getDashboardUpstreamPathMode(slug)).toBe('stripped')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid package.json metadata for ${slug}`),
      expect.anything(),
    )
  })

  describe('waitForStartupOutcome', () => {
    it('resolves immediately for an untracked dashboard', async () => {
      const start = Date.now()
      await manager.waitForStartupOutcome('nope', 5_000)
      expect(Date.now() - start).toBeLessThan(500)
    })

    it('resolves once a starting dashboard reaches its outcome', async () => {
      const slug = await scaffoldDashboard()
      await fs.promises.rm(path.join(testDir, slug, 'node_modules'), { recursive: true })
      let installProc: FakeChildProcess | undefined
      spawnHolder.impl = (_command, args) => {
        const proc = new FakeChildProcess()
        procs.push(proc)
        if (args[0] === 'install') installProc = proc
        return proc
      }

      const start = manager.startDashboard(slug, { forceInstall: false })
      await vi.waitFor(() => expect(installProc).toBeDefined())
      expect(manager.getDashboardStatus(slug)).toBe('starting')

      const outcome = manager.waitForStartupOutcome(slug, 10_000)
      installProc!.exit(0)
      await outcome
      await start

      expect(manager.getDashboardStatus(slug)).toBe('running')
      expect(manager.getDashboardPort(slug)).not.toBeNull()
    })
  })

  describe('status change events', () => {
    it('publishes running when the dashboard becomes serveable', async () => {
      const slug = await scaffoldDashboard()

      await manager.startDashboard(slug, { forceInstall: false })

      expect(statusEventMock).toHaveBeenCalledWith(slug, 'running')
    })

    it('publishes crashed when the restart budget is exhausted', async () => {
      const slug = await scaffoldDashboard()
      const info = await manager.startDashboard(slug, { forceInstall: false })
      statusEventMock.mockClear()

      info.restartTimestamps.push(Date.now(), Date.now(), Date.now())
      procs[0].exit(1, null)

      expect(statusEventMock).toHaveBeenCalledWith(slug, 'crashed')
    })

    it('publishes crashed when the process errors without exiting', async () => {
      const slug = await scaffoldDashboard()
      await manager.startDashboard(slug, { forceInstall: false })
      statusEventMock.mockClear()

      procs[0].emit('error', new Error('spawn ENOENT'))

      expect(statusEventMock).toHaveBeenCalledWith(slug, 'crashed')
    })
  })

  describe('build skip semantics', () => {
    const TEMPLATE_START = 'bun run build && bun run serve.js'

    /** Record every spawn; auto-exit `bun install` procs. */
    function recordSpawns() {
      const spawns: Array<{ command: string; args: string[] }> = []
      spawnHolder.impl = (command, args) => {
        const proc = new FakeChildProcess()
        procs.push(proc)
        spawns.push({ command, args })
        if (args[0] === 'install') setImmediate(() => proc.exit(0))
        return proc
      }
      return spawns
    }

    /** Template-shaped dashboard: template start script, serve.js, built dist. */
    async function scaffoldTemplateDashboard(opts?: {
      start?: string
      dist?: boolean
      distFresh?: boolean
    }): Promise<string> {
      const slug = await scaffoldDashboard({ scripts: { start: opts?.start ?? TEMPLATE_START } })
      const dir = path.join(testDir, slug)
      await fs.promises.writeFile(path.join(dir, 'serve.js'), '// server')
      await fs.promises.mkdir(path.join(dir, 'src'), { recursive: true })
      await fs.promises.writeFile(path.join(dir, 'src', 'App.jsx'), '// app')
      if (opts?.dist !== false) {
        await fs.promises.mkdir(path.join(dir, 'dist'), { recursive: true })
        await fs.promises.writeFile(path.join(dir, 'dist', 'index.html'), '<html></html>')
        const stamp = new Date(Date.now() + (opts?.distFresh === false ? -600_000 : 120_000))
        await fs.promises.utimes(path.join(dir, 'dist', 'index.html'), stamp, stamp)
      }
      return slug
    }

    it('boot start serves directly when the template dist is fresh', async () => {
      const slug = await scaffoldTemplateDashboard()
      const spawns = recordSpawns()

      const info = await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([['run', 'serve.js']])
      expect(info.status).toBe('running')
    })

    it('boot start serves directly for the build-if-needed template variant too', async () => {
      const slug = await scaffoldTemplateDashboard({
        start: 'bun run build-if-needed.js && bun run serve.js',
      })
      const spawns = recordSpawns()

      await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([['run', 'serve.js']])
    })

    it('boot start rebuilds when a source file is newer than dist', async () => {
      const slug = await scaffoldTemplateDashboard({ distFresh: false })
      const spawns = recordSpawns()

      await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([['run', 'start']])
    })

    it('boot start rebuilds when dist is missing', async () => {
      const slug = await scaffoldTemplateDashboard({ dist: false })
      const spawns = recordSpawns()

      await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([['run', 'start']])
    })

    it('agent-initiated start never skips the build, even with a fresh dist', async () => {
      const slug = await scaffoldTemplateDashboard()
      const spawns = recordSpawns()

      await manager.startDashboard(slug)

      expect(spawns.map((s) => s.args)).toEqual([
        ['install', '--network-concurrency=8'],
        ['run', 'start'],
      ])
    })

    it('a customized start script always runs as written', async () => {
      const slug = await scaffoldTemplateDashboard({
        start: 'bun run build && bun run migrate.js && bun run serve.js',
      })
      const spawns = recordSpawns()

      await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([['run', 'start']])
    })
  })

  describe('install semantics', () => {
    /** Record every spawn; auto-exit `bun install` procs with queued codes. */
    function recordSpawns(installExitCodes: number[]) {
      const spawns: Array<{ command: string; args: string[] }> = []
      spawnHolder.impl = (command, args) => {
        const proc = new FakeChildProcess()
        procs.push(proc)
        spawns.push({ command, args })
        if (args[0] === 'install') {
          const code = installExitCodes.shift() ?? 0
          setImmediate(() => proc.exit(code))
        }
        return proc
      }
      return spawns
    }

    it('default start runs bun install even when node_modules is fresh', async () => {
      const slug = await scaffoldDashboard()
      const spawns = recordSpawns([0])

      const info = await manager.startDashboard(slug)

      expect(spawns.map((s) => s.args)).toEqual([
        ['install', '--network-concurrency=8'],
        ['run', 'start'],
      ])
      expect(info.status).toBe('running')
    })

    it('publishes a distinct first-run phase while dependencies install', async () => {
      const slug = await scaffoldDashboard()
      await fs.promises.rm(path.join(testDir, slug, 'node_modules'), { recursive: true })
      let installProc: FakeChildProcess | undefined
      spawnHolder.impl = (_command, args) => {
        const proc = new FakeChildProcess()
        procs.push(proc)
        if (args[0] === 'install') installProc = proc
        return proc
      }

      const start = manager.startDashboard(slug, { forceInstall: false })

      await vi.waitFor(() => expect(installProc).toBeDefined())
      expect(manager.listDashboards()).toContainEqual(expect.objectContaining({
        slug,
        status: 'starting',
        startupPhase: 'installing-dependencies',
        firstRun: true,
      }))

      installProc!.exit(0)
      await start

      const running = manager.listDashboards().find((dashboard) => dashboard.slug === slug)
      expect(running).toEqual(expect.objectContaining({ status: 'running' }))
      expect(running).not.toHaveProperty('startupPhase')
      expect(running).not.toHaveProperty('firstRun')
    })

    it('passes dashboard mount metadata to the dashboard process', async () => {
      const slug = await scaffoldDashboard()
      let dashboardEnv: NodeJS.ProcessEnv | undefined
      process.env.SUPERAGENT_AGENT_ID = 'agent-123'
      spawnHolder.impl = (_command, args, options) => {
        const proc = new FakeChildProcess()
        procs.push(proc)
        if (args[0] === 'install') {
          setImmediate(() => proc.exit(0))
        } else {
          dashboardEnv = (options as { env?: NodeJS.ProcessEnv }).env
        }
        return proc
      }

      try {
        await manager.startDashboard(slug)
      } finally {
        delete process.env.SUPERAGENT_AGENT_ID
      }

      expect(dashboardEnv?.DASHBOARD_BASE_PATH).toBe(
        `/api/agents/agent-123/artifacts/${slug}/`,
      )
      expect(dashboardEnv?.DASHBOARD_ARTIFACT_SLUG).toBe(slug)
    })

    it('boot start skips install when node_modules is fresh', async () => {
      const slug = await scaffoldDashboard()
      const spawns = recordSpawns([])

      await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([['run', 'start']])
    })

    it('stale boot install tries --frozen-lockfile first and falls back on failure', async () => {
      const slug = await scaffoldDashboard()
      const dir = path.join(testDir, slug)
      await fs.promises.writeFile(path.join(dir, 'bun.lock'), '{}')
      // Make node_modules stale so the boot path needs an install
      const past = new Date(Date.now() - 60_000)
      await fs.promises.utimes(path.join(dir, 'node_modules'), past, past)
      await fs.promises.utimes(path.join(dir, 'package.json'), new Date(), new Date())
      const spawns = recordSpawns([1, 0])

      const info = await manager.startDashboard(slug, { forceInstall: false })

      expect(spawns.map((s) => s.args)).toEqual([
        ['install', '--network-concurrency=8', '--frozen-lockfile'],
        ['install', '--network-concurrency=8'],
        ['run', 'start'],
      ])
      expect(info.status).toBe('running')
    })
  })
})
