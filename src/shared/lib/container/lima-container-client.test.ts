import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing the module under test
// ============================================================================

// LIMA_HOME as it was before the module under test loaded.
const limaHomeBeforeImport = vi.hoisted(() => process.env.LIMA_HOME)

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
  cpSync: vi.fn(),
  rmSync: vi.fn(),
  renameSync: vi.fn(),
  constants: { COPYFILE_FICLONE: 2 },
}))

vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: any
    constructor(config: any) { this.config = config }
  },
  checkCommandAvailable: vi.fn(),
  execWithPath: vi.fn(),
  shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
  writeEnvFile: vi.fn(),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => '/Users/testuser/Library/Application Support/Superagent',
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
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
import { execSync } from 'child_process'
import { execWithPath } from './base-container-client'
import { getSettings } from '@shared/lib/config/settings'
import { captureMessage } from '@shared/lib/error-reporting'

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
  limactlCommand,
  verifyDataDirVisibleInVm,
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
    if (cmd.includes('nerdctl info')) return Promise.resolve({ stdout: 'running\n', stderr: '' })
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
 * @param opts.bundled      does the app bundle at /app/resources ship lima/ (limactl, wrapper, image)?
 */
function mockFsState(opts: { version?: string; haSockExists?: boolean; haPid?: string; bundled?: boolean } = {}) {
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
    if (s.startsWith('/app/resources/lima/')) return !!opts.bundled
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

/** Point process.resourcesPath at a fake app bundle (or none). */
function setResourcesPath(value: string | undefined) {
  Object.defineProperty(process, 'resourcesPath', { value, writable: true, configurable: true })
}

describe('getNerdctlWrapperPath', () => {
  const originalHome = process.env.HOME
  const originalResourcesPath = process.resourcesPath

  afterEach(() => {
    process.env.HOME = originalHome
    setResourcesPath(originalResourcesPath)
    mockedFs.existsSync.mockReset()
  })

  it('prefers the wrapper shipped next to the bundled limactl', () => {
    setResourcesPath('/Applications/Gamut 2.app/Contents/Resources')
    mockedFs.existsSync.mockImplementation(((p: any) => String(p) === '/Applications/Gamut 2.app/Contents/Resources/lima/bin/lima-nerdctl') as any)

    expect(getNerdctlWrapperPath()).toBe('/Applications/Gamut 2.app/Contents/Resources/lima/bin/lima-nerdctl')
  })

  it('returns path under HOME/.superagent/bin when the bundle has no wrapper (dev)', () => {
    setResourcesPath('/app/resources')
    mockedFs.existsSync.mockReturnValue(false)
    process.env.HOME = '/Users/testuser'
    const result = getNerdctlWrapperPath()
    expect(result).toBe('/Users/testuser/.superagent/bin/lima-nerdctl')
  })

  it('throws when HOME is not set', () => {
    setResourcesPath(undefined)
    delete process.env.HOME
    expect(() => getNerdctlWrapperPath()).toThrow('HOME environment variable is not set')
  })
})

describe('bundled wrapper environment', () => {
  it('exports the Lima home and VM name the bundled wrapper reads', () => {
    expect(process.env.SUPERAGENT_LIMA_HOME).toBe('/Users/testuser/.superagent/lima')
    expect(process.env.SUPERAGENT_LIMA_VM).toBe(LIMA_VM_NAME)
  })

  it('leaves LIMA_HOME alone, so a limactl the user runs keeps its own VMs', () => {
    expect(process.env.LIMA_HOME).toBe(limaHomeBeforeImport)
  })
})

describe('limactlCommand', () => {
  const originalResourcesPath = process.resourcesPath

  afterEach(() => {
    setResourcesPath(originalResourcesPath)
    mockedFs.existsSync.mockReset()
  })

  it('runs the bundled limactl with a system-only PATH, so it never picks up Homebrew tools', () => {
    setResourcesPath('/app/resources')
    mockedFs.existsSync.mockReturnValue(true)

    expect(limactlCommand('list --json')).toBe(
      'PATH=/usr/bin:/bin:/usr/sbin:/sbin LIMA_HOME="/Users/testuser/.superagent/lima" "/app/resources/lima/bin/limactl" list --json'
    )
  })

  it('keeps the caller PATH for a limactl found on PATH (dev)', () => {
    setResourcesPath(undefined)

    expect(limactlCommand('list --json')).toBe('LIMA_HOME="/Users/testuser/.superagent/lima" "limactl" list --json')
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

  it('runs every limactl call with the system PATH and writes no wrapper when the bundle ships one', async () => {
    setResourcesPath('/app/resources')
    mockExec({ list: [] })
    mockFsState({ bundled: true })

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes('create'))).toBe(true)
    for (const cmd of execCmds()) {
      expect(cmd.startsWith('PATH=/usr/bin:/bin:/usr/sbin:/sbin LIMA_HOME="/Users/testuser/.superagent/lima" "/app/resources/lima/bin/limactl" ')).toBe(true)
    }
    const written = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]))
    expect(written.some((p) => p.endsWith('lima-nerdctl'))).toBe(false)
  })

  it('generates the wrapper under HOME when the bundle ships none (dev)', async () => {
    mockExec({ list: [] })
    mockFsState({})

    await ensureLimaReady()

    const written = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]))
    expect(written).toContain('/Users/testuser/.superagent/bin/lima-nerdctl')
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

    mockedExecWithPath.mockImplementation(((cmd: string) => {
      if (cmd.includes('nerdctl info')) return Promise.resolve({ stdout: 'running\n', stderr: '' })
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

// ============================================================================
// verifyDataDirVisibleInVm — nerdctl creates a missing bind-mount source on the
// VM's own disk and runs anyway, so a run whose workspace the VM can't see must
// be refused before it starts.
// ============================================================================

describe('verifyDataDirVisibleInVm', () => {
  const DATA_DIR = '/Users/testuser/Library/Application Support/Superagent'
  // The check is cached per VM boot (host-agent pid), so each test boots anew.
  let bootPid = 5000

  /** Marker files the check wrote, by path → contents. */
  const markers = () => new Map(mockedFs.writeFileSync.mock.calls.map((c) => [String(c[0]), String(c[1])]))
  const catCmds = () => execCmds().filter((c) => c.includes('.lima-mount-check-'))
  const markerIn = (cmd: string) => /' sh '([^']+)'$/.exec(cmd)?.[1] ?? ''

  /** What the guest sees when it reads the marker (the guest command always exits 0). */
  function guest(sees: 'the marker' | 'nothing' | 'other content' | 'no answer' | 'a stopped VM') {
    mockedExecWithPath.mockImplementation(((cmd: string) => {
      if (!cmd.includes('.lima-mount-check-')) return Promise.resolve({ stdout: '', stderr: '' })
      if (sees === 'the marker') return Promise.resolve({ stdout: `${markers().get(markerIn(cmd))}\n`, stderr: '' })
      if (sees === 'other content') return Promise.resolve({ stdout: 'something else\n', stderr: '' })
      if (sees === 'nothing') return Promise.resolve({ stdout: 'superagent-mount-marker-missing\n', stderr: '' })
      // limactl's own exit 1 is the same code cat uses for a missing file.
      if (sees === 'a stopped VM') return Promise.reject(Object.assign(new Error('level=fatal msg="instance `superagent` is stopped"'), { code: 1 }))
      return Promise.reject(Object.assign(new Error('ssh: connect to host 127.0.0.1 port 60022: Connection refused'), { code: 255 }))
    }) as any)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setResourcesPath(undefined)
    bootPid++
    const pid = String(bootPid)
    mockedFs.readFileSync.mockImplementation(((p: any) => {
      if (String(p).endsWith('ha.pid')) return pid
      const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e
    }) as any)
  })

  it('passes when the guest reads back the nonce written into the data folder, then removes the marker', async () => {
    guest('the marker')

    await verifyDataDirVisibleInVm()

    expect(catCmds()).toHaveLength(1)
    const marker = markerIn(catCmds()[0])
    expect(marker.startsWith(`${DATA_DIR}/.lima-mount-check-`)).toBe(true)
    expect(markers().get(marker)).toMatch(/^[0-9a-f]{32}$/)
    expect(catCmds()[0]).toContain(
      `shell --workdir / ${LIMA_VM_NAME} -- sh -c 'cat "$1" 2>/dev/null || echo superagent-mount-marker-missing' sh '${marker}'`
    )
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith(marker)
  })

  it('checks once per VM boot', async () => {
    guest('the marker')

    await verifyDataDirVisibleInVm()
    await verifyDataDirVisibleInVm()
    expect(catCmds()).toHaveLength(1)

    // The VM restarted: a new host agent, so check again.
    mockedFs.readFileSync.mockImplementation(((p: any) => {
      if (String(p).endsWith('ha.pid')) return String(bootPid + 1000)
      const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e
    }) as any)
    await verifyDataDirVisibleInVm()
    expect(catCmds()).toHaveLength(2)
  })

  it('uses a new marker name for every check, so a cached failed lookup in the guest cannot answer', async () => {
    guest('no answer')
    await verifyDataDirVisibleInVm()
    guest('the marker')
    await verifyDataDirVisibleInVm()

    const [first, second] = catCmds().map(markerIn)
    expect(first).not.toBe(second)
  })

  it('shares one check between concurrent container starts', async () => {
    guest('the marker')

    await Promise.all([verifyDataDirVisibleInVm(), verifyDataDirVisibleInVm(), verifyDataDirVisibleInVm()])

    expect(catCmds()).toHaveLength(1)
  })

  it('refuses the run, reports it, and still removes the marker when the guest cannot see the data folder', async () => {
    guest('nothing')

    const error = await verifyDataDirVisibleInVm().then(() => null, (e) => e)

    expect(error?.message).toContain(`can't see the app's data folder (${DATA_DIR})`)
    expect(error?.sentryCaptured).toBe(true)
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining('cannot see the app data folder'),
      expect.objectContaining({ tags: { component: 'lima', operation: 'mount-check' } })
    )
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith(markerIn(catCmds()[0]))
  })

  it('refuses the run when the guest reads something other than the nonce', async () => {
    guest('other content')

    await expect(verifyDataDirVisibleInVm()).rejects.toThrow(/can't see the app's data folder/)
  })

  it.each(['no answer', 'a stopped VM'] as const)('does not block the run when the guest gives %s, and checks again next time', async (sees) => {
    guest(sees)

    await expect(verifyDataDirVisibleInVm()).resolves.toBeUndefined()
    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled()

    await verifyDataDirVisibleInVm()
    expect(catCmds()).toHaveLength(2)
  })

  it("is Lima's beforeRun hook (start() runs it before every run attempt; see the sup212 start() tests)", async () => {
    guest('nothing')
    const client = new LimaContainerClient({ agentId: 'test-agent' } as any) as any

    await expect(client.beforeRun()).rejects.toThrow(/can't see the app's data folder/)
  })
})

// ============================================================================
// Stopping the VM — power the guest off over SSH first; force-stop only a host
// agent this process can signal. A force-stop of a host agent from another
// launch (EPERM) deletes its pid/socket files without killing it, orphaning
// the VM until a reboot ("EFI variable store is already in use").
// ============================================================================

describe('stopping the VM', () => {
  let killSpy: any

  /**
   * A VM whose host agent is `owner` (ours / another launch / none), and
   * whose guest does or doesn't power off when asked.
   */
  function vm(opts: {
    owner: 'ours' | 'another launch' | 'none'
    poweroffWorks: boolean
    list?: any[]
    startError?: Error
    memorySetting?: string
  }) {
    const state = { pid: opts.owner === 'none' ? undefined : '4321' }
    const enoent = () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    mockedFs.readFileSync.mockImplementation(((p: any) => {
      const s = String(p)
      if (s.endsWith('ha.pid')) return state.pid ?? enoent()
      if (s.endsWith('lima-version')) return 'v99.0.0'
      return ''
    }) as any)
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p)
      if (s.endsWith('ha.pid') || s.endsWith('ha.sock')) return state.pid !== undefined
      return false
    }) as any)
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      const e: any = new Error()
      if (state.pid === undefined) { e.code = 'ESRCH'; throw e }
      if (opts.owner === 'another launch') { e.code = 'EPERM'; throw e }
      return true
    }) as any)
    const listJson = (opts.list ?? []).map((v) => JSON.stringify(v)).join('\n')
    mockedExecWithPath.mockImplementation(((cmd: string) => {
      if (cmd.includes('sudo poweroff')) {
        if (opts.poweroffWorks) state.pid = undefined
        return Promise.reject(new Error('Connection to 127.0.0.1 closed by remote host.'))
      }
      if (cmd.includes('stop --force') || cmd.includes('delete')) {
        // Lima deletes ha.pid either way; it only kills a host agent it may signal.
        state.pid = undefined
        return Promise.resolve({ stdout: '', stderr: '' })
      }
      if (cmd.includes('list --json')) return Promise.resolve({ stdout: listJson, stderr: '' })
      if (cmd.includes('nerdctl info')) return Promise.resolve({ stdout: 'running\n', stderr: '' })
      if (cmd.includes(' start ')) return opts.startError ? Promise.reject(opts.startError) : Promise.resolve({ stdout: '', stderr: '' })
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as any)
    mockedGetSettings.mockReturnValue({
      container: { runtimeSettings: opts.memorySetting ? { lima: { vmMemory: opts.memorySetting } } : {} },
    } as any)
    return state
  }

  const poweroffs = () => execCmds().filter((c) => c.includes(`shell --workdir / ${LIMA_VM_NAME} -- sudo poweroff`))
  const forceStops = () => execCmds().filter((c) => c.includes('stop --force'))
  const deletes = () => execCmds().filter((c) => c.includes(`delete ${LIMA_VM_NAME} --force`))

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    setResourcesPath(undefined)
    process.env.HOME = '/Users/testuser'
    mockedFs.readdirSync.mockReturnValue([] as any)
  })

  afterEach(() => {
    vi.useRealTimers()
    killSpy?.mockRestore()
  })

  it('powers the guest off and does not force-stop once the host agent exits', async () => {
    vm({ owner: 'ours', poweroffWorks: true })

    await stopLimaVm()

    expect(poweroffs()).toHaveLength(1)
    expect(forceStops()).toHaveLength(0)
  })

  it('lists the instance once the host agent has exited, so Lima drops the vz.pid it leaves behind', async () => {
    vm({ owner: 'ours', poweroffWorks: true })

    await stopLimaVm()

    const cmds = execCmds()
    const poweroffAt = cmds.findIndex((c) => c.includes('sudo poweroff'))
    expect(cmds.findIndex((c) => c.includes('list --json'))).toBeGreaterThan(poweroffAt)
  })

  it('stops a VM another launch started by powering its guest off (no signal needed)', async () => {
    vm({ owner: 'another launch', poweroffWorks: true })

    await stopLimaVm()

    expect(poweroffs()).toHaveLength(1)
    expect(forceStops()).toHaveLength(0)
  })

  it('force-stops its own host agent when the guest does not power off in time', async () => {
    vm({ owner: 'ours', poweroffWorks: false })

    const stopped = stopLimaVm(1000)
    await vi.advanceTimersByTimeAsync(1500)
    await stopped

    expect(poweroffs()).toHaveLength(1)
    expect(forceStops()).toHaveLength(1)
  })

  it('never force-stops a host agent it cannot signal, and reports leaving the VM running', async () => {
    vm({ owner: 'another launch', poweroffWorks: false })

    const stopped = stopLimaVm(1000)
    await vi.advanceTimersByTimeAsync(1500)
    await stopped

    expect(forceStops()).toHaveLength(0)
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining('another launch'),
      expect.objectContaining({ tags: { component: 'lima', operation: 'stop-unsignalable' } })
    )
  })

  it('skips the poweroff when no host agent is running', async () => {
    vm({ owner: 'none', poweroffWorks: false })

    await stopLimaVm()

    expect(poweroffs()).toHaveLength(0)
    expect(forceStops()).toHaveLength(1)
  })

  it('a container force-stop never force-stops a host agent it cannot signal', async () => {
    vm({ owner: 'another launch', poweroffWorks: false })

    await (new LimaContainerClient({ agentId: 'test-agent' } as any) as any).forceStop()

    expect(forceStops()).toHaveLength(0)
  })

  it('recreate powers the running VM off before deleting it', async () => {
    vm({ owner: 'ours', poweroffWorks: true, memorySetting: '8GiB', list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }] })

    await ensureLimaReady()

    const cmds = execCmds()
    const poweroffAt = cmds.findIndex((c) => c.includes('sudo poweroff'))
    const deleteAt = cmds.findIndex((c) => c.includes(`delete ${LIMA_VM_NAME} --force`))
    expect(poweroffAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(poweroffAt)
    expect(forceStops()).toHaveLength(0)
    expect(cmds.some((c) => c.includes('create'))).toBe(true)
  })

  it('recreate refuses to delete a VM whose host agent it can neither power off nor signal', async () => {
    vm({ owner: 'another launch', poweroffWorks: false, memorySetting: '8GiB', list: [{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }] })

    const ready = ensureLimaReady().then(() => null, (e) => e)
    await vi.advanceTimersByTimeAsync(20000)
    const error = await ready

    expect(error?.message).toMatch(/could not be stopped to rebuild it/)
    expect(deletes()).toHaveLength(0)
    expect(forceStops()).toHaveLength(0)
    expect(execCmds().some((c) => c.includes('create'))).toBe(false)
  })

  it('zombie cleanup after a failed first start leaves a host agent it cannot signal alone', async () => {
    vm({ owner: 'another launch', poweroffWorks: false, list: [], startError: new Error('EFI variable store is already in use') })

    await expect(ensureLimaReady()).rejects.toThrow('EFI variable store is already in use')

    expect(deletes()).toHaveLength(0)
  })

  it('zombie cleanup still deletes a failed first start this process owns', async () => {
    vm({ owner: 'ours', poweroffWorks: false, list: [], startError: new Error('disk full') })

    await expect(ensureLimaReady()).rejects.toThrow('disk full')

    expect(deletes()).toHaveLength(1)
  })
})

// ============================================================================
// `limactl stop --force` SIGKILLs the pid in vz.pid. A host agent that died
// without cleaning up leaves that file, and its pid may since belong to an
// unrelated process: drop the file first unless the owner is limactl.
// ============================================================================

describe('force-stop with a leftover vz.pid', () => {
  const VZ_PID = '/Users/testuser/.superagent/lima/superagent/vz.pid'
  let killSpy: any

  /** No host agent (ha.pid gone); vz.pid holds 777, which is `owner` (or dead). */
  function leftover(owner: string | 'dead') {
    mockedFs.readFileSync.mockImplementation(((p: any) => {
      if (String(p) === VZ_PID) return '777\n'
      const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e
    }) as any)
    mockedFs.existsSync.mockReturnValue(false)
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      if (owner === 'dead') { const e: any = new Error(); e.code = 'ESRCH'; throw e }
      return true
    }) as any)
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      if (cmd === 'ps -o comm= -p 777') return `${owner}\n`
      throw new Error('unexpected execSync')
    }) as any)
    mockedExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    setResourcesPath(undefined)
  })

  afterEach(() => {
    killSpy?.mockRestore()
    vi.mocked(execSync).mockReset()
  })

  it('drops a vz.pid that points at an unrelated live process before force-stopping', async () => {
    leftover('/usr/bin/vim')

    await stopLimaVm()

    expect(mockedFs.unlinkSync).toHaveBeenCalledWith(VZ_PID)
    expect(execCmds().some((c) => c.includes('stop --force'))).toBe(true)
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining('stale Lima vz.pid'),
      expect.objectContaining({ extra: { process: 'vim' } })
    )
  })

  it('keeps a vz.pid whose live owner is limactl (the host agent itself)', async () => {
    leftover('/Applications/Gamut.app/Contents/Resources/lima/bin/limactl')

    await stopLimaVm()

    expect(mockedFs.unlinkSync).not.toHaveBeenCalled()
  })

  it('leaves a vz.pid whose process is gone to Lima', async () => {
    leftover('dead')

    await stopLimaVm()

    expect(mockedFs.unlinkSync).not.toHaveBeenCalled()
    expect(vi.mocked(execSync)).not.toHaveBeenCalled()
  })
})

// ============================================================================
// First-boot packages — a packaged build installs containerd/nerdctl from the
// apk repository bundled with the app (staged into the data folder the VM
// mounts), never from the network.
// ============================================================================

describe('first-boot packages', () => {
  const BUNDLED = '/app/resources/lima/packages'
  const STAGED = '/Users/testuser/Library/Application Support/Superagent/lima-packages'
  const INSTANCE_YAML = '/Users/testuser/.superagent/lima/superagent/lima.yaml'

  /** A filesystem with an optional bundle, staged copy and existing VM. */
  function files(opts: { bundle?: string; staged?: string; instanceYaml?: string }) {
    const enoent = () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
    mockedFs.readFileSync.mockImplementation(((p: any) => {
      const s = String(p)
      if (s === `${BUNDLED}/packages.txt`) return opts.bundle ?? enoent()
      if (s === `${STAGED}/packages.txt`) return opts.staged ?? enoent()
      if (s === INSTANCE_YAML) return opts.instanceYaml ?? enoent()
      if (s.endsWith('lima-version')) return 'v99.0.0'
      return enoent()
    }) as any)
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p)
      if (s === `${BUNDLED}/packages.txt`) return opts.bundle !== undefined
      if (s.startsWith('/app/resources/lima/')) return true // limactl, wrapper, image
      return false
    }) as any)
  }

  /** The lima.yaml handed to `limactl create`. */
  const createdConfig = () =>
    String(mockedFs.writeFileSync.mock.calls.find((c) => /vm-config-\d+\.yaml$/.test(String(c[0])))?.[1] ?? '')

  let killSpy: any
  beforeEach(() => {
    vi.clearAllMocks()
    setResourcesPath('/app/resources')
    process.env.HOME = '/Users/testuser'
    mockedGetSettings.mockReturnValue({ container: { runtimeSettings: {} } } as any)
    mockedFs.readdirSync.mockReturnValue([] as any)
    killSpy = deadPid()
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  it('a new VM installs them from the staged bundle only: no network, no other repositories', async () => {
    files({ bundle: 'containerd-2.2.0-r8\n' })
    mockExec({ list: [] })

    await ensureLimaReady()

    const config = createdConfig()
    // A dependency script runs inside Lima's own package step, before it: Lima
    // then finds rsync and installs nothing from Alpine's CDN itself. apk
    // misreads a repository path with a space (the data folder has one): a link.
    expect(config).toContain([
      'provision:',
      '  - mode: dependency',
      '    script: |',
      '      #!/bin/sh',
      '      set -e',
      '      command -v nerdctl >/dev/null 2>&1 && command -v rsync >/dev/null 2>&1 && exit 0',
      '      echo "Installing containerd + nerdctl from the packages bundled with the app..."',
      `      ln -sfn '${STAGED}' /run/superagent-lima-packages`,
      '      apk add --no-network --no-cache --repositories-file /dev/null --repository /run/superagent-lima-packages/main --repository /run/superagent-lima-packages/community containerd~=2.2 containerd-openrc nerdctl~=2.1 buildkit~=0.25 cni-plugins rsync',
      '  - mode: system',
      '    script: |',
      '      #!/bin/sh',
      '      set -e',
      '      rc-update show default | grep -q containerd || rc-update add containerd default',
      '      service containerd start || true',
    ].join('\n'))
    expect(config).not.toContain('apk update')
    expect(mockedFs.cpSync).toHaveBeenCalledWith(BUNDLED, `${STAGED}.partial-${process.pid}`, expect.objectContaining({ recursive: true, mode: 2 }))
    expect(mockedFs.renameSync).toHaveBeenCalledWith(`${STAGED}.partial-${process.pid}`, STAGED)
  })

  it('without bundled packages (dev), a new VM installs them from Alpine', async () => {
    files({})
    mockExec({ list: [] })

    await ensureLimaReady()

    const config = createdConfig()
    expect(config).toContain('apk update')
    expect(config).toContain('apk add --no-cache containerd~=2.2 containerd-openrc nerdctl~=2.1 buildkit~=0.25 cni-plugins')
    expect(config).not.toContain('--no-network')
    expect(mockedFs.cpSync).not.toHaveBeenCalled()
  })

  it('does not copy again when the staged copy already matches the bundle', async () => {
    files({ bundle: 'containerd-2.2.0-r8\n', staged: 'containerd-2.2.0-r8\n' })
    mockExec({ list: [] })

    await ensureLimaReady()

    expect(mockedFs.cpSync).not.toHaveBeenCalled()
    expect(createdConfig()).toContain(`ln -sfn '${STAGED}' /run/superagent-lima-packages`)
  })

  // What createLimaVm writes into a bundled build's VM.
  const bundledInstanceYaml = `provision:\n  - mode: dependency\n    script: |\n      ln -sfn '${STAGED}' /run/superagent-lima-packages\n`

  it('restages them before starting a VM whose first boot reads them, so a cut-short first boot can provision again', async () => {
    files({ bundle: 'containerd-2.2.0-r8\n', instanceYaml: bundledInstanceYaml })
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Stopped', memory: 4 * 1024 ** 3 }] })

    await ensureLimaReady()

    expect(mockedFs.cpSync).toHaveBeenCalledWith(BUNDLED, `${STAGED}.partial-${process.pid}`, expect.anything())
    const startCall = execCmds().findIndex((c) => c.includes(' start '))
    expect(startCall).toBeGreaterThanOrEqual(0)
    expect(mockedFs.cpSync.mock.invocationCallOrder[0]).toBeLessThan(mockedExecWithPath.mock.invocationCallOrder[startCall])
    expect(execCmds().some((c) => c.includes('create'))).toBe(false)
  })

  it('still starts the VM when restaging fails (only an unfinished first boot needs the copy)', async () => {
    files({ bundle: 'containerd-2.2.0-r8\n', instanceYaml: bundledInstanceYaml })
    mockedFs.cpSync.mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) })
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Stopped', memory: 4 * 1024 ** 3 }] })

    await ensureLimaReady()

    expect(execCmds().some((c) => c.includes(' start '))).toBe(true)
  })

  it('leaves a VM an older app provisioned from the network alone', async () => {
    files({ bundle: 'containerd-2.2.0-r8\n', instanceYaml: 'provision:\n  apk update\n  apk add --no-cache containerd~=2.2' })
    mockExec({ list: [{ name: LIMA_VM_NAME, status: 'Stopped', memory: 4 * 1024 ** 3 }] })

    await ensureLimaReady()

    expect(mockedFs.cpSync).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Lima only warns when a provision script fails and reports the VM ready
// anyway, without containerd. ensureLimaReady() checks after every start.
// ============================================================================

describe('containerd after a start', () => {
  type State = 'running' | 'not running' | 'not installed'
  /** containerd's state in the guest before, after the provisioning re-run, and after a rebuild. */
  function guest(opts: { before: State | 'no answer'; afterRerun?: State | 'no answer'; afterRebuild?: State }) {
    let state: State | 'no answer' = opts.before
    mockedExecWithPath.mockImplementation(((cmd: string) => {
      if (cmd.includes('list --json')) {
        return Promise.resolve({ stdout: JSON.stringify({ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 ** 3 }), stderr: '' })
      }
      if (cmd.includes(`create --name ${LIMA_VM_NAME}`)) {
        state = opts.afterRebuild ?? 'running'
        return Promise.resolve({ stdout: '', stderr: '' })
      }
      if (cmd.includes('-- true')) return Promise.resolve({ stdout: '', stderr: '' })
      if (cmd.includes('nerdctl info')) {
        if (state === 'no answer') return Promise.reject(Object.assign(new Error('ssh failed'), { code: 255 }))
        return Promise.resolve({ stdout: `${state}\n`, stderr: '' })
      }
      if (cmd.includes('/mnt/lima-cidata/provision.')) {
        state = opts.afterRerun ?? 'running'
        return state === 'running'
          ? Promise.resolve({ stdout: 'Installing containerd + nerdctl...', stderr: '' })
          : Promise.reject(Object.assign(new Error('ERROR: unable to select packages: containerd (no such package)'), { code: 1 }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }) as any)
  }
  const reruns = () => execCmds().filter((c) => c.includes('/mnt/lima-cidata/provision.'))

  let killSpy: any
  beforeEach(() => {
    vi.clearAllMocks()
    setResourcesPath(undefined)
    process.env.HOME = '/Users/testuser'
    mockedGetSettings.mockReturnValue({ container: { runtimeSettings: {} } } as any)
    mockedFs.readdirSync.mockReturnValue([] as any)
    mockFsState({ version: 'v99.0.0', haSockExists: true })
    killSpy = deadPid()
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  it('does nothing more when containerd answers', async () => {
    guest({ before: 'running' })

    await ensureLimaReady()

    expect(reruns()).toHaveLength(0)
  })

  it.each(['not installed', 'not running'] as const)(
    "re-runs the VM's own dependency and system provision scripts when containerd is %s, and reports the fix",
    async (before) => {
      guest({ before, afterRerun: 'running' })

      await ensureLimaReady()

      expect(reruns()).toHaveLength(1)
      expect(reruns()[0]).toContain(
        `shell --workdir / ${LIMA_VM_NAME} -- sudo sh -c 'for f in /mnt/lima-cidata/provision.dependency/* /mnt/lima-cidata/provision.system/*; do [ -e "$f" ] || continue; sh "$f" || exit 1; done'`
      )
      expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
        expect.stringContaining('re-running its provisioning fixed it'),
        expect.objectContaining({ level: 'warning', tags: { component: 'lima', operation: 'provision-check' }, extra: expect.objectContaining({ before }) })
      )
    }
  )

  it('rebuilds a VM the re-run cannot fix when containerd was never installed: it holds nothing to lose', async () => {
    guest({ before: 'not installed', afterRerun: 'not installed', afterRebuild: 'running' })

    await ensureLimaReady()

    const cmds = execCmds()
    const deleteAt = cmds.findIndex((c) => c.includes(`delete ${LIMA_VM_NAME} --force`))
    expect(deleteAt).toBeGreaterThan(cmds.findIndex((c) => c.includes('/mnt/lima-cidata/provision.')))
    expect(cmds.findIndex((c) => c.includes(`create --name ${LIMA_VM_NAME}`))).toBeGreaterThan(deleteAt)
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining('rebuilding it'),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ output: expect.stringContaining('unable to select packages') }),
      })
    )
  })

  it('refuses with a clear error when the rebuilt VM has no containerd either', async () => {
    guest({ before: 'not installed', afterRerun: 'not installed', afterRebuild: 'not installed' })

    const error = await ensureLimaReady().then(() => null, (e) => e)

    expect(error?.message).toMatch(/couldn't set up its container engine/)
    expect(error?.sentryCaptured).toBe(true)
    expect(execCmds().filter((c) => c.includes(`create --name ${LIMA_VM_NAME}`))).toHaveLength(1)
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.stringContaining('still has no containerd after a rebuild'),
      expect.objectContaining({ level: 'error', tags: { component: 'lima', operation: 'provision-check' } })
    )
  })

  it('never rebuilds a VM whose containerd is installed but not answering (it may hold images and containers)', async () => {
    guest({ before: 'not running', afterRerun: 'not running' })

    const error = await ensureLimaReady().then(() => null, (e) => e)

    expect(error?.message).toMatch(/container engine isn't running/)
    expect(error?.sentryCaptured).toBe(true)
    expect(execCmds().some((c) => c.includes('delete'))).toBe(false)
    expect(execCmds().some((c) => c.includes(`create --name ${LIMA_VM_NAME}`))).toBe(false)
  })

  it('leaves a guest that does not answer to the usual recovery', async () => {
    guest({ before: 'no answer' })

    await ensureLimaReady()

    expect(reruns()).toHaveLength(0)
  })

  it('does not report a repair when the guest stops answering after the re-run', async () => {
    guest({ before: 'not running', afterRerun: 'no answer' })

    await ensureLimaReady()

    expect(vi.mocked(captureMessage)).not.toHaveBeenCalledWith(expect.stringContaining('fixed it'), expect.anything())
  })
})
