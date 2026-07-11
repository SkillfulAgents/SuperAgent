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
  truncateOversizedLog,
} from './dashboard-manager'

const spawnHolder = vi.hoisted(() => ({
  impl: null as ((command: string, args: string[], options: unknown) => unknown) | null,
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
    startDashboard(slug: string): Promise<{
      status: string
      logStream: fs.WriteStream | null
      restartTimestamps: number[]
    }>
    stopDashboard(slug: string): Promise<boolean>
    stopAll(): Promise<void>
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
  async function scaffoldDashboard(): Promise<string> {
    const slug = `dash-${++slugCounter}`
    const dir = path.join(testDir, slug)
    await fs.promises.mkdir(path.join(dir, 'node_modules'), { recursive: true })
    await fs.promises.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: slug, scripts: { start: 'true' } })
    )
    // node_modules must be at least as new as package.json to skip install
    const future = new Date(Date.now() + 60_000)
    await fs.promises.utimes(path.join(dir, 'node_modules'), future, future)
    return slug
  }

  it('closes the log stream when the process exits cleanly', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug)
    expect(info.status).toBe('running')
    const stream = info.logStream!
    expect(stream.writableEnded).toBe(false)

    procs[0].exit(0, null)

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
  })

  it('closes the log stream on the crash path', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug)
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
    const info = await manager.startDashboard(slug)
    const stream = info.logStream!

    procs[0].emit('error', new Error('spawn ENOENT'))

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
    expect(info.status).toBe('crashed')
  })

  it('restart-while-running closes the old stream and opens a new one without double-end errors', async () => {
    const slug = await scaffoldDashboard()
    const first = await manager.startDashboard(slug)
    const oldStream = first.logStream!

    // Restarting kills the old process; its exit ALSO triggers the close
    // handler — the old stream must end exactly once (a second end() would
    // throw ERR_STREAM_ALREADY_FINISHED as an uncaught exception).
    const second = await manager.startDashboard(slug)

    expect(oldStream.writableEnded).toBe(true)
    expect(second.logStream).not.toBe(oldStream)
    expect(second.logStream!.writableEnded).toBe(false)
    expect(second.status).toBe('running')
  })

  it('stopDashboard ends the stream even though the close handler also ran', async () => {
    const slug = await scaffoldDashboard()
    const info = await manager.startDashboard(slug)
    const stream = info.logStream!

    await manager.stopDashboard(slug)

    expect(stream.writableEnded).toBe(true)
    expect(info.logStream).toBeNull()
  })

  it('truncates an oversized dashboard.log on start', async () => {
    const slug = await scaffoldDashboard()
    const logPath = path.join(testDir, slug, 'dashboard.log')
    await fs.promises.writeFile(logPath, Buffer.alloc(11 * 1024 * 1024, 0x61))

    await manager.startDashboard(slug)

    const stat = await fs.promises.stat(logPath)
    expect(stat.size).toBeLessThan(1024 * 1024)
  })
})
