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
  },
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: any
    constructor(config: any) { this.config = config }
    protected getContainerName() { return `superagent-${this.config.agentId}` }
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

async function loadFreshLimaModuleForTest() {
  vi.resetModules()

  const fsModule = await import('fs')
  const baseModule = await import('./base-container-client')
  const settingsModule = await import('@shared/lib/config/settings')
  const limaModule = await import('./lima-container-client')

  return {
    mockedFs: vi.mocked(fsModule),
    mockedExecWithPath: vi.mocked(baseModule.execWithPath),
    mockedGetSettings: vi.mocked(settingsModule.getSettings),
    ...limaModule,
  }
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
  })

  function mockLimaList(vms: any[]) {
    const ndjson = vms.map((v) => JSON.stringify(v)).join('\n')
    mockedExecWithPath.mockResolvedValueOnce({ stdout: ndjson, stderr: '' })
  }

  /** Mock the lima-version file so the version check doesn't trigger a recreate */
  function mockLimaVersion(version = 'v99.0.0') {
    mockedFs.readFileSync.mockReturnValue(version)
  }

  it('creates VM and starts it when no VM exists', async () => {
    // First list: no VMs (VM exists check)
    mockLimaList([])
    // createLimaVm: execLimactl('create ...')
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // Second list: VM exists but stopped (running check)
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Stopped' }])
    // start VM
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await ensureLimaReady()

    // Verify create and start were called
    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('create'))).toBe(true)
    expect(calls.some((c) => c.includes('start'))).toBe(true)
  })

  it('skips creation when VM already exists and running', async () => {
    mockLimaVersion()
    // First list: VM exists and running
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }])
    // Second list: still running
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Running' }])

    await ensureLimaReady()

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('create'))).toBe(false)
    expect(calls.some((c) => c.includes('start '))).toBe(false)
  })

  it('mutex serializes concurrent calls', async () => {
    mockLimaVersion()
    let resolveList: ((v: any) => void) | null = null
    let callCount = 0

    mockedExecWithPath.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First list call — slow
        return new Promise((resolve) => {
          resolveList = resolve
        })
      }
      // Subsequent calls resolve immediately
      return Promise.resolve({ stdout: JSON.stringify({ name: LIMA_VM_NAME, status: 'Running' }) + '\n', stderr: '' })
    })

    // Launch two concurrent calls
    const p1 = ensureLimaReady()
    const p2 = ensureLimaReady()

    // Only one should be in-flight (callCount should be 1 from the first list call)
    expect(callCount).toBe(1)

    // Resolve the first list call
    resolveList!({ stdout: JSON.stringify({ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }) + '\n', stderr: '' })

    await Promise.all([p1, p2])
  })

  it('cleans up zombie VM when start fails after creation', async () => {
    // First list: no VMs
    mockLimaList([])
    // createLimaVm succeeds
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // Second list: VM exists but stopped
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Stopped' }])
    // start VM fails
    mockedExecWithPath.mockRejectedValueOnce(new Error('disk full'))
    // delete VM (cleanup)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(ensureLimaReady()).rejects.toThrow('disk full')

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('delete') && c.includes('--force'))).toBe(true)
  })

  it('does NOT delete VM when start fails on pre-existing VM', async () => {
    mockLimaVersion()
    // First list: VM exists
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Stopped', memory: 4 * 1024 * 1024 * 1024 }])
    // Second list: still stopped
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Stopped' }])
    // start VM fails
    mockedExecWithPath.mockRejectedValueOnce(new Error('network error'))

    await expect(ensureLimaReady()).rejects.toThrow('network error')

    // Should NOT have called delete — VM existed before this call
    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('delete'))).toBe(false)
  })

  it('recreates VM when memory setting differs', async () => {
    mockLimaVersion()
    mockedGetSettings.mockReturnValue({
      container: { runtimeSettings: { lima: { vmMemory: '8GiB' } } },
    } as any)

    // First list: VM exists with 4GiB
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }])
    // stop --force
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // delete --force
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // createLimaVm
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // list (running check)
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Stopped' }])
    // start
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await ensureLimaReady()

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('delete') && c.includes('--force'))).toBe(true)
    expect(calls.some((c) => c.includes('create'))).toBe(true)
  })

  it('recreates VM when lima-version is older than minimum', async () => {
    mockLimaVersion('v2.0.3')

    // First list: VM exists
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 }])
    // stop --force
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // delete --force
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // createLimaVm
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // list (running check)
    mockLimaList([{ name: LIMA_VM_NAME, status: 'Stopped' }])
    // start
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await ensureLimaReady()

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('delete') && c.includes('--force'))).toBe(true)
    expect(calls.some((c) => c.includes('create'))).toBe(true)
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

// ============================================================================
// LimaContainerClient.handleRunError — corrupted image recovery
// ============================================================================

describe('LimaContainerClient.handleRunError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'resourcesPath', { value: undefined, writable: true, configurable: true })
    process.env.HOME = '/Users/testuser'
    mockedFs.readFileSync.mockReturnValue('v2.1.1')
    mockedGetSettings.mockReturnValue({ container: { agentImage: 'ghcr.io/test/image:latest' } } as any)
  })

  it('rebuilds Lima VM on corrupted snapshot', async () => {
    const client = new LimaContainerClient({ agentId: 'test-agent' } as any)
    const error = new Error('level=fatal msg="mount callback failed on /tmp/containerd-mount123: no users found"')
    const existingVm = JSON.stringify({ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 })
    mockedExecWithPath
      .mockResolvedValueOnce({ stdout: existingVm, stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await (client as any).handleRunError(error)

    expect(result).toBe(true)
    expect(mockedExecWithPath.mock.calls.some((c) => (c[0] as string).includes(`stop ${LIMA_VM_NAME} --force`))).toBe(true)
    expect(mockedExecWithPath.mock.calls.some((c) => (c[0] as string).includes(`delete ${LIMA_VM_NAME} --force`))).toBe(true)
  })

  it('returns false when VM rebuild fails', async () => {
    const client = new LimaContainerClient({ agentId: 'test-agent' } as any)
    const error = new Error('mount callback failed: no users found')
    const existingVm = JSON.stringify({ name: LIMA_VM_NAME, status: 'Running', memory: 4 * 1024 * 1024 * 1024 })
    mockedExecWithPath
      .mockResolvedValueOnce({ stdout: existingVm, stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('rebuild failed'))

    expect(await (client as any).handleRunError(error)).toBe(false)
  })
})

describe('LimaContainerClient.reconcileRuntimeState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'resourcesPath', { value: undefined, writable: true, configurable: true })
    process.env.HOME = '/Users/testuser'
  })

  it('rebuilds VM when image layers are corrupted', async () => {
    const {
      LimaContainerClient: FreshLimaContainerClient,
      LIMA_VM_NAME: freshVmName,
      mockedFs: freshMockedFs,
      mockedExecWithPath: freshMockedExecWithPath,
      mockedGetSettings: freshMockedGetSettings,
    } = await loadFreshLimaModuleForTest()

    freshMockedGetSettings.mockReturnValue({ container: { agentImage: 'ghcr.io/test/image:latest', runtimeSettings: {} } } as any)
    freshMockedFs.readFileSync.mockReturnValue('v99.0.0')
    const existingVm = JSON.stringify({ name: freshVmName, status: 'Running', memory: 4 * 1024 * 1024 * 1024 })
    freshMockedExecWithPath
      // nerdctl run --rm (image integrity check) fails with corruption error
      .mockRejectedValueOnce(new Error('mount callback failed on /tmp/containerd-mount123: no users found'))
      // ensureLimaReady(true): list VMs
      .mockResolvedValueOnce({ stdout: existingVm, stderr: '' })
      // stop --force
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // delete --force
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // create
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // list (running check)
      .mockResolvedValueOnce({ stdout: JSON.stringify({ name: LIMA_VM_NAME, status: 'Stopped' }), stderr: '' })
      // start
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const rebuilt = await FreshLimaContainerClient.reconcileRuntimeState()

    expect(rebuilt).toBe(true)
    expect(freshMockedExecWithPath.mock.calls.some((c) => (c[0] as string).includes('nerdctl run --rm'))).toBe(true)
    expect(freshMockedExecWithPath.mock.calls.some((c) => (c[0] as string).includes(`stop ${freshVmName} --force`))).toBe(true)
    expect(freshMockedExecWithPath.mock.calls.some((c) => (c[0] as string).includes(`delete ${freshVmName} --force`))).toBe(true)
  })

  it('returns false when VM and image are healthy', async () => {
    const {
      LimaContainerClient: FreshLimaContainerClient,
      mockedFs: freshMockedFs,
      mockedExecWithPath: freshMockedExecWithPath,
      mockedGetSettings: freshMockedGetSettings,
    } = await loadFreshLimaModuleForTest()

    freshMockedGetSettings.mockReturnValue({ container: { agentImage: 'ghcr.io/test/image:latest', runtimeSettings: {} } } as any)
    freshMockedFs.readFileSync.mockReturnValue('v99.0.0')
    // nerdctl run --rm succeeds
    freshMockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    const rebuilt = await FreshLimaContainerClient.reconcileRuntimeState()

    expect(rebuilt).toBe(false)
  })
})

describe('LimaContainerClient.isRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'resourcesPath', {
      value: undefined,
      writable: true,
      configurable: true,
    })
  })

  it('returns true when VM is running (tests parseLimaList indirectly)', async () => {
    const ndjson = JSON.stringify({ name: LIMA_VM_NAME, status: 'Running' })
    mockedExecWithPath.mockResolvedValueOnce({ stdout: ndjson, stderr: '' })

    expect(await LimaContainerClient.isRunning()).toBe(true)
  })

  it('returns false when VM is stopped', async () => {
    const ndjson = JSON.stringify({ name: LIMA_VM_NAME, status: 'Stopped' })
    mockedExecWithPath.mockResolvedValueOnce({ stdout: ndjson, stderr: '' })

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false when no VMs exist (empty output)', async () => {
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('returns false on exec error', async () => {
    mockedExecWithPath.mockRejectedValueOnce(new Error('limactl not found'))

    expect(await LimaContainerClient.isRunning()).toBe(false)
  })

  it('handles multi-line NDJSON with multiple VMs', async () => {
    const lines = [
      JSON.stringify({ name: 'other-vm', status: 'Running' }),
      JSON.stringify({ name: LIMA_VM_NAME, status: 'Running' }),
    ].join('\n')
    mockedExecWithPath.mockResolvedValueOnce({ stdout: lines, stderr: '' })

    expect(await LimaContainerClient.isRunning()).toBe(true)
  })

  it('handles NDJSON with invalid lines mixed in', async () => {
    const lines = [
      'not json',
      JSON.stringify({ name: LIMA_VM_NAME, status: 'Running' }),
      '{broken',
    ].join('\n')
    mockedExecWithPath.mockResolvedValueOnce({ stdout: lines, stderr: '' })

    expect(await LimaContainerClient.isRunning()).toBe(true)
  })
})
