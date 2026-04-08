import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing the module under test
// ============================================================================

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: (...args: any[]) => mockSpawn(...args),
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

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => 'C:\\Users\\testuser'),
    tmpdir: vi.fn(() => 'C:\\Users\\testuser\\AppData\\Local\\Temp'),
    arch: vi.fn(() => 'x64'),
  },
  homedir: vi.fn(() => 'C:\\Users\\testuser'),
  tmpdir: vi.fn(() => 'C:\\Users\\testuser\\AppData\\Local\\Temp'),
  arch: vi.fn(() => 'x64'),
}))

vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: any
    constructor(config: any) { this.config = config }
  },
  checkCommandAvailable: vi.fn(),
  execWithPath: vi.fn(),
  shellQuote: vi.fn((s: string) => `"${s}"`),
  writeEnvFile: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({
    container: { runtimeSettings: {} },
    apiKeys: { anthropicApiKey: 'test-key' },
  })),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: vi.fn(() => 'C:\\Users\\testuser\\.superagent'),
}))

import * as fs from 'fs'
import { execWithPath, writeEnvFile } from './base-container-client'

// ============================================================================
// Import module under test — AFTER mocks
// ============================================================================

import {
  windowsToWSLPath,
  getWSL2NerdctlWrapperPath,
  getWSL2Home,
  WSL2_DISTRO_NAME,
  ensureWSL2Ready,
  stopWSL2Distro,
  WSL2ContainerClient,
} from './wsl2-container-client'

const mockedFs = vi.mocked(fs)
const mockedExecWithPath = vi.mocked(execWithPath)
const mockedWriteEnvFile = vi.mocked(writeEnvFile)

// ============================================================================
// windowsToWSLPath
// ============================================================================

describe('windowsToWSLPath', () => {
  it('converts backslash Windows path', () => {
    expect(windowsToWSLPath('C:\\Users\\foo\\bar')).toBe('/mnt/c/Users/foo/bar')
  })

  it('converts forward-slash Windows path', () => {
    expect(windowsToWSLPath('C:/Users/foo/bar')).toBe('/mnt/c/Users/foo/bar')
  })

  it('handles different drive letters', () => {
    expect(windowsToWSLPath('D:\\Data\\stuff')).toBe('/mnt/d/Data/stuff')
  })

  it('lowercases drive letter', () => {
    expect(windowsToWSLPath('E:\\Path')).toBe('/mnt/e/Path')
  })

  it('returns Linux paths unchanged', () => {
    expect(windowsToWSLPath('/usr/local/bin')).toBe('/usr/local/bin')
  })

  it('handles root of drive', () => {
    expect(windowsToWSLPath('C:\\')).toBe('/mnt/c/')
  })
})

// ============================================================================
// getWSL2NerdctlWrapperPath
// ============================================================================

describe('getWSL2NerdctlWrapperPath', () => {
  it('returns path under homedir/.superagent/bin', () => {
    const result = getWSL2NerdctlWrapperPath()
    // path.join on the test platform will use the correct separator
    expect(result).toContain('.superagent')
    expect(result).toContain('wsl-nerdctl.cmd')
  })
})

// ============================================================================
// getWSL2Home
// ============================================================================

describe('getWSL2Home', () => {
  it('returns data dir + /wsl2', () => {
    const result = getWSL2Home()
    expect(result).toContain('wsl2')
  })
})

// ============================================================================
// ensureWSL2Ready — mutex and state machine
// ============================================================================

describe('ensureWSL2Ready', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    })
  })

  // Helper to mock spawn for provisioning (returns a fake child process)
  function mockSpawnProvision(exitCode = 0, stderrOutput = '') {
    const { EventEmitter } = require('events')
    const proc = new EventEmitter()
    proc.stdin = { write: vi.fn(), end: vi.fn() }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    mockSpawn.mockReturnValueOnce(proc)
    // Emit close on next tick so the promise resolves
    process.nextTick(() => {
      if (stderrOutput) proc.stderr.emit('data', Buffer.from(stderrOutput))
      proc.emit('close', exitCode)
    })
  }

  // Helper to mock wsl --list --verbose output
  function mockWSLList(distros: { name: string; state: string }[]) {
    // Simulate wsl --list --verbose output (with UTF-16LE null bytes stripped)
    const header = '  NAME                   STATE           VERSION'
    const lines = distros.map(d => `  ${d.name.padEnd(23)}${d.state.padEnd(16)}2`)
    const stdout = [header, ...lines].join('\n')
    mockedExecWithPath.mockResolvedValueOnce({ stdout, stderr: '' })
  }

  it('creates distro and starts it when no distro exists', async () => {
    // First list: no distros
    mockWSLList([])
    // wsl --import
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // Provision via spawn (piped stdin)
    mockSpawnProvision(0)
    // Second list: distro exists but stopped
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Stopped' }])
    // Start distro (wsl -d superagent -- echo starting)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'starting', stderr: '' })
    // Provisioning check: test -x /usr/local/bin/superagent-nerdctl (passes — just provisioned)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // nerdctl version check (containerd ready)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check: test -d /mnt/c/Windows
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    // Mock bundled rootfs
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\app\\resources',
      writable: true,
      configurable: true,
    })
    mockedFs.existsSync.mockReturnValue(true)

    await ensureWSL2Ready()

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('--import'))).toBe(true)
  })

  it('skips creation when distro already exists and running', async () => {
    // First list: distro exists and running
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Second list: still running
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Provisioning check: test -x /usr/local/bin/superagent-nerdctl (passes)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // nerdctl version check
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check: test -d /mnt/c/Windows
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await ensureWSL2Ready()

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('--import'))).toBe(false)
  })

  it('mutex serializes concurrent calls', async () => {
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
      const header = '  NAME                   STATE           VERSION'
      const line = `  ${WSL2_DISTRO_NAME.padEnd(23)}Running         2`
      return Promise.resolve({ stdout: `${header}\n${line}`, stderr: '' })
    })

    // Launch two concurrent calls
    const p1 = ensureWSL2Ready()
    const p2 = ensureWSL2Ready()

    // Only one should be in-flight
    expect(callCount).toBe(1)

    // Resolve the first list call
    const header = '  NAME                   STATE           VERSION'
    const line = `  ${WSL2_DISTRO_NAME.padEnd(23)}Running         2`
    resolveList!({ stdout: `${header}\n${line}`, stderr: '' })

    await Promise.all([p1, p2])
  })

  it('re-provisions distro when superagent-nerdctl is missing', async () => {
    // First list: distro exists and running
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Second list: still running
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Provisioning check: test -x fails (helper missing)
    mockedExecWithPath.mockRejectedValueOnce(new Error('exit code 1'))
    // Re-provision via spawn
    mockSpawnProvision(0)
    // nerdctl version check
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check: test -d /mnt/c/Windows
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await ensureWSL2Ready()

    // spawn should have been called for provisioning
    expect(mockSpawn).toHaveBeenCalledWith('wsl', ['-d', WSL2_DISTRO_NAME, '--', 'sh', '-s'], expect.any(Object))
  })

  it('unregisters distro and throws when re-provisioning fails', async () => {
    // First list: distro exists and running
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Second list: still running
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Provisioning check: test -x fails (helper missing)
    mockedExecWithPath.mockRejectedValueOnce(new Error('exit code 1'))
    // Re-provision fails via spawn
    mockSpawnProvision(1, 'apk: network unreachable')
    // Unregister (cleanup)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(ensureWSL2Ready()).rejects.toThrow('Failed to provision WSL2 distro')

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('--unregister'))).toBe(true)
  })

  it('cleans up zombie distro when start fails after creation', async () => {
    // First list: no distros
    mockWSLList([])
    // wsl --import
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // Provision via spawn
    mockSpawnProvision(0)
    // Second list: distro exists but stopped
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Stopped' }])
    // Start fails
    mockedExecWithPath.mockRejectedValueOnce(new Error('WSL error'))
    // Unregister (cleanup)
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    // Mock bundled rootfs
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\app\\resources',
      writable: true,
      configurable: true,
    })
    mockedFs.existsSync.mockReturnValue(true)

    await expect(ensureWSL2Ready()).rejects.toThrow('WSL error')

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.some((c) => c.includes('--unregister'))).toBe(true)
  })

  it('recreates distro when mount health check fails', async () => {
    // First attempt: distro exists and running but mounts are broken
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    // Provisioning check passes
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // nerdctl version passes
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check FAILS
    mockedExecWithPath.mockRejectedValueOnce(new Error('exit code 1'))
    // Unregister broken distro
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    // Retry: distro doesn't exist, needs creation
    mockWSLList([])
    // wsl --import
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // Provision via spawn
    mockSpawnProvision(0)
    // Second list: distro stopped
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Stopped' }])
    // Start distro
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'starting', stderr: '' })
    // Provisioning check passes
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // nerdctl version passes
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check passes on retry
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    // Mock bundled rootfs
    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\app\\resources',
      writable: true,
      configurable: true,
    })
    mockedFs.existsSync.mockReturnValue(true)

    await ensureWSL2Ready()

    const calls = mockedExecWithPath.mock.calls.map((c) => c[0] as string)
    expect(calls.filter((c) => c.includes('--unregister')).length).toBe(1)
    expect(calls.some((c) => c.includes('--import'))).toBe(true)
  })

  it('throws on mount health check failure after retry', async () => {
    // First attempt: broken mounts
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Running' }])
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check fails
    mockedExecWithPath.mockRejectedValueOnce(new Error('exit code 1'))
    // Unregister
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    // Retry: distro recreated but mounts still broken
    mockWSLList([])
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    mockSpawnProvision(0)
    mockWSLList([{ name: WSL2_DISTRO_NAME, state: 'Stopped' }])
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'starting', stderr: '' })
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version', stderr: '' })
    // Mount health check fails again
    mockedExecWithPath.mockRejectedValueOnce(new Error('exit code 1'))

    Object.defineProperty(process, 'resourcesPath', {
      value: 'C:\\app\\resources',
      writable: true,
      configurable: true,
    })
    mockedFs.existsSync.mockReturnValue(true)

    await expect(ensureWSL2Ready()).rejects.toThrow('cannot mount the Windows filesystem')
  })
})

// ============================================================================
// stopWSL2Distro — timeout logic
// ============================================================================

describe('stopWSL2Distro', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves when stop completes quickly', async () => {
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })

    const promise = stopWSL2Distro()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves even when stop times out (does not throw)', async () => {
    // Stop never resolves
    mockedExecWithPath.mockReturnValueOnce(new Promise(() => {}))

    const promise = stopWSL2Distro(100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves when stop throws (distro not running)', async () => {
    mockedExecWithPath.mockRejectedValueOnce(new Error('Distro not running'))

    const promise = stopWSL2Distro()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toBeUndefined()
  })
})

// ============================================================================
// WSL2ContainerClient.isRunning
// ============================================================================

describe('WSL2ContainerClient.isRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when distro is running and nerdctl works', async () => {
    const header = '  NAME                   STATE           VERSION'
    const line = `  ${WSL2_DISTRO_NAME.padEnd(23)}Running         2`
    // wsl --list --verbose
    mockedExecWithPath.mockResolvedValueOnce({ stdout: `${header}\n${line}`, stderr: '' })
    // nerdctl version check
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'nerdctl version 2.1', stderr: '' })

    expect(await WSL2ContainerClient.isRunning()).toBe(true)
  })

  it('returns false when distro is stopped', async () => {
    const header = '  NAME                   STATE           VERSION'
    const line = `  ${WSL2_DISTRO_NAME.padEnd(23)}Stopped         2`
    mockedExecWithPath.mockResolvedValueOnce({ stdout: `${header}\n${line}`, stderr: '' })

    expect(await WSL2ContainerClient.isRunning()).toBe(false)
  })

  it('returns false when no distros exist', async () => {
    const header = '  NAME                   STATE           VERSION'
    mockedExecWithPath.mockResolvedValueOnce({ stdout: header, stderr: '' })

    expect(await WSL2ContainerClient.isRunning()).toBe(false)
  })

  it('returns false on exec error', async () => {
    mockedExecWithPath.mockRejectedValueOnce(new Error('wsl not found'))

    expect(await WSL2ContainerClient.isRunning()).toBe(false)
  })

  it('handles other distros in the list', async () => {
    const header = '  NAME                   STATE           VERSION'
    const lines = [
      `* Ubuntu                 Running         2`,
      `  ${WSL2_DISTRO_NAME.padEnd(23)}Running         2`,
    ]
    mockedExecWithPath.mockResolvedValueOnce({ stdout: [header, ...lines].join('\n'), stderr: '' })
    // nerdctl version check
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'ok', stderr: '' })

    expect(await WSL2ContainerClient.isRunning()).toBe(true)
  })
})

// ============================================================================
// WSL2ContainerClient.isEligible
// ============================================================================

describe('WSL2ContainerClient.isEligible', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true,
    })
  })

  it('returns true on win32', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true,
    })
    expect(WSL2ContainerClient.isEligible()).toBe(true)
  })

  it('returns false on darwin', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true,
    })
    expect(WSL2ContainerClient.isEligible()).toBe(false)
  })

  it('returns false on linux', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true,
    })
    expect(WSL2ContainerClient.isEligible()).toBe(false)
  })
})

// ============================================================================
// WSL2ContainerClient.buildEnvFile — path translation
// ============================================================================

describe('WSL2ContainerClient.buildEnvFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // buildEnvFile is a protected method, so we test it via a subclass
  class TestableWSL2Client extends WSL2ContainerClient {
    public testBuildEnvFile(additionalEnvVars?: Record<string, string>) {
      return this.buildEnvFile(additionalEnvVars)
    }
  }

  function createClient(config?: Partial<{ agentId: string; envVars: Record<string, string> }>) {
    return new TestableWSL2Client({
      agentId: config?.agentId ?? 'test-agent',
      envVars: config?.envVars,
    })
  }

  it('translates Windows env file path to WSL2 path', () => {
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "C:\\Users\\testuser\\.superagent\\tmp\\superagent-env-test-agent-123"',
      filePath: 'C:\\Users\\testuser\\.superagent\\tmp\\superagent-env-test-agent-123',
      cleanup: vi.fn(),
    })

    const client = createClient()
    const result = client.testBuildEnvFile()

    expect(result.flag).toBe('--env-file "/mnt/c/Users/testuser/.superagent/tmp/superagent-env-test-agent-123"')
  })

  it('translates paths with different drive letters', () => {
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "D:\\Data\\tmp\\env-file"',
      filePath: 'D:\\Data\\tmp\\env-file',
      cleanup: vi.fn(),
    })

    const client = createClient()
    const result = client.testBuildEnvFile()

    expect(result.flag).toBe('--env-file "/mnt/d/Data/tmp/env-file"')
  })

  it('handles forward-slash Windows paths', () => {
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "C:/Users/testuser/tmp/env-file"',
      filePath: 'C:/Users/testuser/tmp/env-file',
      cleanup: vi.fn(),
    })

    const client = createClient()
    const result = client.testBuildEnvFile()

    expect(result.flag).toBe('--env-file "/mnt/c/Users/testuser/tmp/env-file"')
  })

  it('passes through the cleanup function from writeEnvFile', () => {
    const mockCleanup = vi.fn()
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "C:\\tmp\\env"',
      filePath: 'C:\\tmp\\env',
      cleanup: mockCleanup,
    })

    const client = createClient()
    const result = client.testBuildEnvFile()

    result.cleanup()
    expect(mockCleanup).toHaveBeenCalledOnce()
  })

  it('passes agent envVars and additional envVars to writeEnvFile', () => {
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "C:\\tmp\\env"',
      filePath: 'C:\\tmp\\env',
      cleanup: vi.fn(),
    })

    const client = createClient({ agentId: 'my-agent', envVars: { FOO: 'bar' } })
    client.testBuildEnvFile({ EXTRA: 'val' })

    expect(mockedWriteEnvFile).toHaveBeenCalledOnce()
    const [envVars, agentId] = mockedWriteEnvFile.mock.calls[0]
    expect(agentId).toBe('my-agent')
    expect(envVars).toMatchObject({
      ANTHROPIC_API_KEY: 'test-key',
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
      FOO: 'bar',
      EXTRA: 'val',
    })
  })

  it('writes to the .superagent/tmp directory under homedir', () => {
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "C:\\tmp\\env"',
      filePath: 'C:\\tmp\\env',
      cleanup: vi.fn(),
    })

    const client = createClient()
    client.testBuildEnvFile()

    const [, , tmpDir] = mockedWriteEnvFile.mock.calls[0]
    // path.join on test platform — check key components
    expect(tmpDir).toContain('.superagent')
    expect(tmpDir).toContain('tmp')
  })

  it('handles paths with spaces', () => {
    mockedWriteEnvFile.mockReturnValue({
      flag: '--env-file "C:\\Users\\Test User\\AppData\\tmp\\env-file"',
      filePath: 'C:\\Users\\Test User\\AppData\\tmp\\env-file',
      cleanup: vi.fn(),
    })

    const client = createClient()
    const result = client.testBuildEnvFile()

    expect(result.flag).toBe('--env-file "/mnt/c/Users/Test User/AppData/tmp/env-file"')
  })
})

// ============================================================================
// WSL2ContainerClient.handleRunError — auto-provisioning
// ============================================================================

describe('WSL2ContainerClient.handleRunError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  class TestableWSL2Client extends WSL2ContainerClient {
    public testHandleRunError(error: any) {
      return this.handleRunError(error)
    }
  }

  function createClient() {
    return new TestableWSL2Client({ agentId: 'test-agent' })
  }

  function mockEnsureWSL2ReadySuccess() {
    // ensureWSL2Ready calls: wsl --list, wsl --list again, test -x provisioning check, nerdctl version, mount health check
    // Mock a running distro for the minimal path
    const header = '  NAME                   STATE           VERSION'
    const line = `  ${WSL2_DISTRO_NAME.padEnd(23)}Running         2`
    const runningOutput = { stdout: `${header}\n${line}`, stderr: '' }
    // First list: running
    mockedExecWithPath.mockResolvedValueOnce(runningOutput)
    // Second list: running
    mockedExecWithPath.mockResolvedValueOnce(runningOutput)
    // Provisioning check: test -x /usr/local/bin/superagent-nerdctl
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
    // nerdctl version
    mockedExecWithPath.mockResolvedValueOnce({ stdout: 'ok', stderr: '' })
    // Mount health check: test -d /mnt/c/Windows
    mockedExecWithPath.mockResolvedValueOnce({ stdout: '', stderr: '' })
  }

  it('returns true and provisions on ENOENT error', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError(new Error('ENOENT: wsl-nerdctl.cmd not found'))
    expect(result).toBe(true)
  })

  it('returns true on "not found" error', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError(new Error('Command not found'))
    expect(result).toBe(true)
  })

  it('returns true on "does not exist" error', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError(new Error('The distribution does not exist'))
    expect(result).toBe(true)
  })

  it('returns true on "not running" error', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError(new Error('WSL distro is not running'))
    expect(result).toBe(true)
  })

  it('returns true on "is not recognized" error', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError(new Error('wsl-nerdctl.cmd is not recognized'))
    expect(result).toBe(true)
  })

  it('returns true on EACCES error', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError(new Error('EACCES: permission denied'))
    expect(result).toBe(true)
  })

  it('returns false on unrecognized error (e.g., network error)', async () => {
    const client = createClient()
    const result = await client.testHandleRunError(new Error('Connection refused'))
    expect(result).toBe(false)
    // Should not have called ensureWSL2Ready
    expect(mockedExecWithPath).not.toHaveBeenCalled()
  })

  it('returns false when provisioning fails', async () => {
    // ensureWSL2ReadyImpl: first wsl --list is caught silently (distroExists=false),
    // then createWSL2Distro is called which calls getBundledRootfsPath().
    // Mock existsSync to false so bundled rootfs isn't found, causing createWSL2Distro to throw.
    mockedExecWithPath.mockRejectedValue(new Error('WSL not installed'))
    mockedFs.existsSync.mockReturnValue(false)

    const client = createClient()
    const result = await client.testHandleRunError(new Error('ENOENT'))
    expect(result).toBe(false)
  })

  it('handles error with stderr property', async () => {
    mockEnsureWSL2ReadySuccess()
    const client = createClient()
    const result = await client.testHandleRunError({ stderr: 'No such file or directory' })
    expect(result).toBe(true)
  })

  it('handles non-Error objects', async () => {
    const client = createClient()
    const result = await client.testHandleRunError('some random string error')
    expect(result).toBe(false)
  })
})
