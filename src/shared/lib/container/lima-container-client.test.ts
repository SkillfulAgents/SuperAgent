import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing the module under test
// ============================================================================

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}))

vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: any
    constructor(config: any) { this.config = config }
  },
  checkCommandAvailable: vi.fn(),
  execWithPath: vi.fn(),
  writeEnvFile: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({
    container: { runtimeSettings: {} },
    apiKeys: { anthropicApiKey: 'test-key' },
  })),
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(() => '/Users/testuser'),
    },
  }
})

import * as fs from 'fs'
import { execWithPath } from './base-container-client'
import { getSettings } from '@shared/lib/config/settings'

// ============================================================================
// Import module under test — AFTER mocks
// ============================================================================

import {
  getNerdctlWrapperPath,
  getLimactlPath,
  getLimaHome,
  LIMA_VM_NAME,
  ensureLimaReady,
  stopLimaVm,
  LimaContainerClient,
} from './lima-container-client'

const mockedFs = vi.mocked(fs)
const mockedExecWithPath = vi.mocked(execWithPath)
const mockedGetSettings = vi.mocked(getSettings)

// ============================================================================
// Shared mock helpers
//
// isRunning() and ensureLimaReady() now probe REAL VM health (SUP-291), so a
// single call can fan out to `limactl list`, an `ha.sock` fs check, an `ha.pid`
// liveness check, and a `limactl shell -- true` guest probe. Drive execWithPath
// by inspecting the limactl subcommand (not a fixed sequence) so adding a probe
// doesn't desync the mocks, and make fs reads path-aware.
// ============================================================================

/**
 * @param opts.list           VMs returned by `limactl list --json`
 * @param opts.guestReachable does `limactl shell -- true` resolve? (default true)
 * @param opts.startError     make `limactl start` reject with this error
 */
function mockExec(opts: { list?: any[]; guestReachable?: boolean; startError?: Error } = {}) {
  const listJson = (opts.list ?? []).map((v) => JSON.stringify(v)).join('\n')
  mockedExecWithPath.mockImplementation(((cmd: string) => {
    if (cmd.includes('list --json')) return Promise.resolve({ stdout: listJson, stderr: '' })
    if (cmd.includes('-- true')) {
      return (opts.guestReachable ?? true)
        ? Promise.resolve({ stdout: '', stderr: '' })
        : Promise.reject(new Error('guest unreachable'))
    }
    if (cmd.includes(' start ')) {
      return opts.startError ? Promise.reject(opts.startError) : Promise.resolve({ stdout: '', stderr: '' })
    }
    // create / delete / stop — succeed
    return Promise.resolve({ stdout: '', stderr: '' })
  }) as any)
}

/**
 * Path-aware fs mock for the version/ha.pid/ha.sock reads the health check makes.
 * @param opts.version      contents of `lima-version` (undefined → file missing)
 * @param opts.haSockExists is `ha.sock` present?
 * @param opts.haPid        contents of `ha.pid` (undefined → file missing)
 */
function mockFsState(opts: { version?: string; haSockExists?: boolean; haPid?: string } = {}) {
  mockedFs.readFileSync.mockImplementation(((p: any) => {
    const s = String(p)
    if (s.endsWith('ha.pid')) {
      if (opts.haPid === undefined) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return opts.haPid
    }
    if (s.endsWith('lima-version')) {
      if (opts.version === undefined) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return opts.version
    }
    return ''
  }) as any)
  mockedFs.existsSync.mockImplementation(((p: any) => {
    const s = String(p)
    if (s.endsWith('ha.sock')) return !!opts.haSockExists
    if (s.endsWith('ha.pid')) return opts.haPid !== undefined
    return false
  }) as any)
}

/** Make `process.kill(pid, 0)` report the pid as dead (ESRCH) — host agent gone. */
function deadPid(): any {
  return vi.spyOn(process, 'kill').mockImplementation((() => {
    const e: any = new Error('ESRCH'); e.code = 'ESRCH'; throw e
  }) as any)
}

/** Make `process.kill(pid, 0)` succeed — host agent process is alive. */
function alivePid(): any {
  return vi.spyOn(process, 'kill').mockImplementation((() => true) as any)
}

/** The full limactl command strings execWithPath was called with. */
function execCmds(): string[] {
  return mockedExecWithPath.mock.calls.map((c) => c[0] as string)
}

// ============================================================================
// parseLimaList — test indirectly via LimaContainerClient.isRunning()
// and ensureLimaReady() since it's not exported.
// We'll test the parsing logic through the public APIs that use it.
// ============================================================================

describe('getNerdctlWrapperPath', () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    process.env.HOME = originalHome
  })

  it('returns path under HOME/.superagent/bin', () => {
    process.env.HOME = '/Users/testuser'
    const result = getNerdctlWrapperPath()
    expect(result).toBe('/Users/testuser/.superagent/bin/lima-nerdctl')
  })

  it('throws when HOME is not set', () => {
    delete process.env.HOME
    expect(() => getNerdctlWrapperPath()).toThrow('HOME environment variable is not set')
  })
})

describe('getLimactlPath', () => {
  const originalResourcesPath = process.resourcesPath

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    })
  })

  it('returns bundled path when it exists', () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/app/resources',
      writable: true,
      configurable: true,
    })
    mockedFs.existsSync.mockReturnValue(true)

    const result = getLimactlPath()
    expect(result).toBe('/app/resources/lima/bin/limactl')
  })

  it('falls back to system limactl when bundled not found', () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: '/app/resources',
      writable: true,
      configurable: true,
    })
    mockedFs.existsSync.mockReturnValue(false)

    const result = getLimactlPath()
    expect(result).toBe('limactl')
  })

  it('falls back to system limactl when resourcesPath is undefined', () => {
    Object.defineProperty(process, 'resourcesPath', {
      value: undefined,
      writable: true,
      configurable: true,
    })

    const result = getLimactlPath()
    expect(result).toBe('limactl')
  })
})

describe('getLimaHome', () => {
  it('returns homedir + /.superagent/lima (short path to avoid UNIX_PATH_MAX)', () => {
    const result = getLimaHome()
    expect(result).toBe('/Users/testuser/.superagent/lima')
  })
})

// ============================================================================
// ensureLimaReady — mutex and state machine
// ============================================================================

describe('ensureLimaReady', () => {
  let killSpy: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetSettings.mockReturnValue({
      container: { runtimeSettings: {} },
    } as any)
    // Default: bundled limactl not found, use system
    Object.defineProperty(process, 'resourcesPath', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    // Default: getNerdctlWrapperPath needs HOME
    process.env.HOME = '/Users/testuser'
    mockedFs.readdirSync.mockReturnValue([] as any)
    // Default: any referenced host-agent pid is dead unless a test says otherwise.
    killSpy = deadPid()
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  it('creates VM and starts it when no VM exists', async () => {
    mockExec({ list: [] })
    mockFsState({})

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes('create'))).toBe(true)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
  })

  it('skips creation and start when VM exists and is healthy', async () => {
    // Running + ha.sock present + guest reachable = genuinely healthy.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }], guestReachable: true })
    mockFsState({ version: 'v99.0.0', haSockExists: true })

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes('create'))).toBe(false)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(false)
  })

  it('mutex serializes concurrent calls', async () => {
    mockFsState({ version: 'v99.0.0', haSockExists: true })
    const runningJson = JSON.stringify({ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }) + '\n'
    let resolveList: ((v: any) => void) | null = null
    let callCount = 0

    mockedExecWithPath.mockImplementation((() => {
      callCount++
      if (callCount === 1) {
        // First list call — slow
        return new Promise((resolve) => { resolveList = resolve })
      }
      // Subsequent calls (list / guest probe) resolve immediately
      return Promise.resolve({ stdout: runningJson, stderr: '' })
    }) as any)

    const p1 = ensureLimaReady()
    const p2 = ensureLimaReady()

    // Only one should be in-flight (the first list call)
    expect(callCount).toBe(1)

    resolveList!({ stdout: runningJson, stderr: '' })

    await Promise.all([p1, p2])
  })

  it('cleans up zombie VM when start fails after creation', async () => {
    mockExec({ list: [], startError: new Error('disk full') })
    mockFsState({})

    await expect(ensureLimaReady()).rejects.toThrow('disk full')

    expect(execCmds().some((c) => c.includes('delete') && c.includes('--force'))).toBe(true)
  })

  it('does NOT delete VM when start fails on pre-existing VM', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Stopped', memory: 4 * 1024 * 1024 * 1024 }], startError: new Error('network error') })
    mockFsState({ version: 'v99.0.0' })

    await expect(ensureLimaReady()).rejects.toThrow('network error')

    // VM existed before this call → must not be destroyed.
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
  })

  it('recreates VM when memory setting differs', async () => {
    mockedGetSettings.mockReturnValue({
      container: { runtimeSettings: { lima: { vmMemory: '8GiB' } } },
    } as any)
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }] })
    mockFsState({ version: 'v99.0.0' })

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes('delete') && c.includes('--force'))).toBe(true)
    expect(execCmds().some((c) => c.includes('create'))).toBe(true)
  })

  it('recreates VM when lima-version is older than minimum', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }] })
    mockFsState({ version: 'v2.0.3' })

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes('delete') && c.includes('--force'))).toBe(true)
    expect(execCmds().some((c) => c.includes('create'))).toBe(true)
  })

  // ==========================================================================
  // SUP-291: self-heal a dirty instance dir + reachability-based health check
  // ==========================================================================

  it('self-heals a dirty instance dir (dead ha.pid) by cleaning stale sockets then restarting', async () => {
    // limactl says Running, but a force-killed vz left ha.sock gone and a stale
    // ha.pid pointing at a dead process.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }] })
    mockFsState({ version: 'v99.0.0', haSockExists: false, haPid: '4242' })
    killSpy.mockRestore()
    killSpy = deadPid() // pid 4242 is dead

    await ensureLimaReady()

    const unlinked = mockedFs.unlinkSync.mock.calls.map((c) => String(c[0]))
    expect(unlinked.some((p) => p.endsWith('ha.pid'))).toBe(true)
    // Restarted to recover — and NOT a destructive delete/recreate.
    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
  })

  it('recovers a VM whose ha.sock was deleted (ELECTRON-4S) by restarting on next launch', async () => {
    // ha.sock missing, no ha.pid (host agent gone) — the canonical ELECTRON-4S dir.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }] })
    mockFsState({ version: 'v99.0.0', haSockExists: false })

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
  })

  it('does NOT rebuild, restart, or clean a wedged-but-live VM (guest probe times out)', async () => {
    // Running + ha.sock present + guest unreachable + host agent ALIVE = memory wedge.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }], guestReachable: false })
    mockFsState({ version: 'v99.0.0', haSockExists: true, haPid: '777' })
    killSpy.mockRestore()
    killSpy = alivePid()

    await expect(ensureLimaReady()).rejects.toThrow(/memory|unreachable/i)

    // Recoverable surface, NOT a destructive rebuild — and never touch a live VM's sockets.
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(false)
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled()
  })

  it('treats sock-missing + LIVE host agent as wedged — never cleans a live VM', async () => {
    // ha.sock gone but the host-agent process is still alive: must NOT be cleaned
    // (would orphan the live VM) and must NOT be restarted/rebuilt.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }] })
    mockFsState({ version: 'v99.0.0', haSockExists: false, haPid: '777' })
    killSpy.mockRestore()
    killSpy = alivePid()

    await expect(ensureLimaReady()).rejects.toThrow(/memory|unreachable|load/i)

    expect(mockedFs.unlinkSync).not.toHaveBeenCalled()
    expect(execCmds().some((c) => c.includes(' start '))).toBe(false)
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
  })

  it('heals an orphaned-socket dirty dir (ha.sock present, guest unreachable, host agent DEAD) — dirty, not wedged', async () => {
    // Distinct from a wedge: the socket file lingers but the host-agent process
    // is gone, so this is a dead-agent dirty dir → clean + restart, NOT a throw.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }], guestReachable: false })
    mockFsState({ version: 'v99.0.0', haSockExists: true }) // no ha.pid → agent dead

    await ensureLimaReady()

    const unlinked = mockedFs.unlinkSync.mock.calls.map((c) => String(c[0]))
    expect(unlinked.some((p) => p.endsWith('ha.sock'))).toBe(true)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
  })

  it('sweeps orphaned *.sock files (e.g. ssh.sock) when cleaning a dirty dir, leaving non-sockets', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }] })
    // dirty: ha.sock + ha.pid gone (dead agent), but orphaned runtime sockets remain
    mockedFs.readFileSync.mockImplementation(((p: any) => {
      const s = String(p)
      if (s.endsWith('ha.pid')) { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      if (s.endsWith('lima-version')) return 'v99.0.0'
      return ''
    }) as any)
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p)
      if (s.endsWith('ha.sock')) return false // missing → dirty
      if (s.endsWith('ssh.sock') || s.endsWith('default_ep.sock')) return true
      return false
    }) as any)
    mockedFs.readdirSync.mockReturnValue(['ssh.sock', 'default_ep.sock', 'cidata.iso', 'lima.yaml'] as any)

    await ensureLimaReady()

    const unlinked = mockedFs.unlinkSync.mock.calls.map((c) => String(c[0]))
    expect(unlinked.some((p) => p.endsWith('ssh.sock'))).toBe(true)
    expect(unlinked.some((p) => p.endsWith('default_ep.sock'))).toBe(true)
    // non-socket files are never touched
    expect(unlinked.some((p) => p.endsWith('cidata.iso'))).toBe(false)
    expect(unlinked.some((p) => p.endsWith('lima.yaml'))).toBe(false)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
  })
})

// ============================================================================
// stopLimaVm — timeout logic
// ============================================================================

describe('stopLimaVm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    Object.defineProperty(process, 'resourcesPath', {
      value: undefined,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves when stop completes quickly', async () => {
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    const promise = stopLimaVm()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves even when stop times out (does not throw)', async () => {
    // Stop never resolves
    mockedExecWithPath.mockReturnValueOnce(new Promise(() => {}))

    const promise = stopLimaVm(100)
    await vi.advanceTimersByTimeAsync(100)
    // Should not throw — error is caught
    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves when stop throws (VM not running)', async () => {
    mockedExecWithPath.mockRejectedValueOnce(new Error('VM not running'))

    const promise = stopLimaVm()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toBeUndefined()
  })
})

// ============================================================================
// LimaContainerClient static methods
// ============================================================================

describe('LimaContainerClient.isRunning', () => {
  let killSpy: any

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'resourcesPath', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    process.env.HOME = '/Users/testuser'
    mockedFs.readdirSync.mockReturnValue([] as any)
    killSpy = deadPid()
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  it('returns true when the VM is healthy (Running + ha.sock present + guest reachable)', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running' }], guestReachable: true })
    mockFsState({ haSockExists: true })

    expect(await LimaContainerClient.isRunning()).toBe(true)
  })

  it('returns false when VM is stopped', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Stopped' }] })
    mockFsState({})

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false when no VMs exist (empty output)', async () => {
    mockExec({ list: [] })
    mockFsState({})

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false on exec error', async () => {
    mockedExecWithPath.mockRejectedValue(new Error('limactl not found'))

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false when limactl reports Running but ha.sock is missing (dirty dir → ELECTRON-4S)', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running' }] })
    mockFsState({ haSockExists: false }) // no ha.pid → host agent dead → dirty

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false when Running with ha.sock but the guest probe times out (wedge)', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running' }], guestReachable: false })
    mockFsState({ haSockExists: true, haPid: '777' })
    killSpy.mockRestore()
    killSpy = alivePid()

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false for an orphaned socket (Running, ha.sock present, guest unreachable, host agent DEAD → dirty)', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running' }], guestReachable: false })
    mockFsState({ haSockExists: true }) // no ha.pid → dead agent → dirty (not wedged)

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('handles multi-line NDJSON with multiple VMs', async () => {
    mockExec({
      list: [
        { name: 'other-vm', status: 'Running' },
        { name: LIMA_VM_NAME, status: 'Running' },
      ],
      guestReachable: true,
    })
    mockFsState({ haSockExists: true })

    expect(await LimaContainerClient.isRunning()).toBe(true)
  })

  it('handles NDJSON with invalid lines mixed in', async () => {
    const lines = [
      'not json',
      JSON.stringify({ name: LIMA_VM_NAME, status: 'Running' }),
      '{broken',
    ].join('\n')
    mockedExecWithPath.mockImplementation(((cmd: string) => {
      if (cmd.includes('list --json')) return Promise.resolve({ stdout: lines, stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' }) // guest probe ok
    }) as any)
    mockFsState({ haSockExists: true })

    expect(await LimaContainerClient.isRunning()).toBe(true)
  })
})

// ============================================================================
// extractInaccessibleMountPath — EPERM-on-stat for cloud-synced bind mounts
// ============================================================================

describe('LimaContainerClient.extractInaccessibleMountPath', () => {
  // The base class is mocked above, so the subclass method runs standalone.
  const client = new LimaContainerClient({ agentId: 'test-agent' } as any) as any

  it('parses the host path from a quoted "failed to stat ... operation not permitted" error', () => {
    const stderr =
      'failed to mount: failed to stat "/Users/x/Library/CloudStorage/Dropbox/foo": operation not permitted'
    expect(client.extractInaccessibleMountPath(new Error(stderr))).toBe(
      '/Users/x/Library/CloudStorage/Dropbox/foo'
    )
  })

  it('parses an iCloud Mobile Documents path', () => {
    const stderr =
      'stat "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/proj": operation not permitted'
    expect(client.extractInaccessibleMountPath({ stderr })).toBe(
      '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/proj'
    )
  })

  // The REAL on-the-wire format: nerdctl logs via logrus, which wraps the
  // message in msg="..." and escapes the inner quotes around the path as \".
  // (Captured from a live `nerdctl run -v <denied-path>` against the Lima VM.)
  // Without unescaping, the parser would return `\"<path>\"` and the mount-drop
  // filter would never match — so the inaccessible mount would never be dropped.
  it('parses the host path from logrus-escaped (\\") nerdctl stderr', () => {
    const stderr =
      'time="2026-06-04T18:17:11-07:00" level=fatal msg="failed to stat \\"/Users/x/Library/Mail\\": stat /Users/x/Library/Mail: operation not permitted"'
    expect(client.extractInaccessibleMountPath({ stderr })).toBe('/Users/x/Library/Mail')
  })

  it('parses a logrus-escaped path that contains spaces (iCloud Mobile Documents)', () => {
    const stderr =
      'level=fatal msg="failed to stat \\"/Users/x/Library/Mobile Documents/com~apple~CloudDocs\\": operation not permitted"'
    expect(client.extractInaccessibleMountPath({ stderr })).toBe(
      '/Users/x/Library/Mobile Documents/com~apple~CloudDocs'
    )
  })

  it('returns null when the error is not an EPERM-on-mount', () => {
    expect(client.extractInaccessibleMountPath(new Error('no such image: foo'))).toBe(null)
  })

  it('returns null for permission errors without a parseable path', () => {
    expect(client.extractInaccessibleMountPath(new Error('operation not permitted'))).toBe(null)
  })
})

// ============================================================================
// handleRunError — SUP-291: recovery is driven by the REAL health probe, not
// `limactl list` trust, so a Running-but-dirty VM (e.g. a build that failed on
// a missing ha.sock) is recognized and self-healed, while a wedged VM is
// surfaced but never destructively rebuilt.
// ============================================================================

describe('LimaContainerClient.handleRunError', () => {
  let killSpy: any
  const makeClient = () => new LimaContainerClient({ agentId: 'test-agent' } as any) as any

  beforeEach(() => {
    vi.clearAllMocks()
    mockedGetSettings.mockReturnValue({ container: { runtimeSettings: {} } } as any)
    Object.defineProperty(process, 'resourcesPath', { value: undefined, writable: true, configurable: true })
    process.env.HOME = '/Users/testuser'
    mockedFs.readdirSync.mockReturnValue([] as any)
    killSpy = deadPid()
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  it('self-heals a dirty VM on a build failure whose message is not a known-issue string', async () => {
    // A "Container build failed" message contains lowercase "no such file" which
    // does NOT match the known-issue list — so recovery hinges on the health probe.
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }] })
    mockFsState({ version: 'v99.0.0', haSockExists: false, haPid: '4242' }) // sock gone + pid dead → dirty

    const recovered = await makeClient().handleRunError(
      new Error('Container build failed with code 255: stat …/ha.sock: no such file or directory')
    )

    expect(recovered).toBe(true)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
  })

  it('does NOT recover when the VM is healthy (the VM is not the fault)', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }], guestReachable: true })
    mockFsState({ version: 'v99.0.0', haSockExists: true })

    const recovered = await makeClient().handleRunError(new Error('some unexpected build error'))

    expect(recovered).toBe(false)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(false)
  })

  it('treats an untagged "not found" error as a known VM issue (control for the tag below)', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }], guestReachable: true })
    mockFsState({ version: 'v99.0.0', haSockExists: true })

    const recovered = await makeClient().handleRunError(
      new Error('Image pull failed with exit code 1: ghcr.io/x/y:9.9.9: not found')
    )

    // String-match short-circuits to ensureLimaReady, which no-ops on the
    // healthy VM and reports "recovered" — triggering a pointless retry.
    expect(recovered).toBe(true)
  })

  it('never treats a registry "not found" from an image create as a VM issue', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }], guestReachable: true })
    mockFsState({ version: 'v99.0.0', haSockExists: true })

    const recovered = await makeClient().handleRunError(
      Object.assign(new Error('Image pull failed with exit code 1: ghcr.io/x/y:9.9.9: not found'), {
        isImageCreateError: true,
        sentryCaptured: true,
      })
    )

    // Tagged create errors defer to the health probe; the VM is healthy, so
    // there is nothing to recover and the pull error surfaces immediately.
    expect(recovered).toBe(false)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(false)
  })

  it('does NOT rebuild a wedged VM — recovery surfaces it and reports unrecovered', async () => {
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }], guestReachable: false })
    mockFsState({ version: 'v99.0.0', haSockExists: true, haPid: '777' })
    killSpy.mockRestore()
    killSpy = alivePid()

    const recovered = await makeClient().handleRunError(new Error('some unexpected build error'))

    expect(recovered).toBe(false)
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
    expect(execCmds().some((c) => c.includes(' start '))).toBe(false)
  })
})
