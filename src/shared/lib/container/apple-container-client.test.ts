import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

const mockExecWithPath = vi.fn()
const mockExecSyncWithPath = vi.fn()
vi.mock('@shared/lib/proxy/host-url', () => ({
  getAppPort: () => 47891,
}))
vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: { agentId: string }
    constructor(config: { agentId: string }) {
      this.config = config
    }
    getContainerName() {
      return `superagent-${this.config.agentId}`
    }
    getRunnerShellCommand() {
      return 'container'
    }
    getHostApiBaseUrl() {
      return 'http://host.docker.internal:47891'
    }
  },
  execWithPath: (...args: unknown[]) => mockExecWithPath(...args),
  execSyncWithPath: (...args: unknown[]) => mockExecSyncWithPath(...args),
  CONTAINER_INTERNAL_PORT: 3000,
  shellEscape: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}))

const mockRunWithAdminPrivileges = vi.fn()
const mockIsAdminPrivilegeCancelError = vi.fn((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('User canceled') || message.includes('-128')
})
vi.mock('@shared/lib/run-with-admin-privileges', () => ({
  runWithAdminPrivileges: (...args: unknown[]) => mockRunWithAdminPrivileges(...args),
  isAdminPrivilegeCancelError: (error: unknown) => mockIsAdminPrivilegeCancelError(error),
}))

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

import {
  AppleContainerClient,
  APPLE_CONTAINER_PKG_SHA256,
  appleContainerProvisionIO,
  ensureAppleContainerReady,
  resetAppleContainerClientForTests,
} from './apple-container-client'

const CLI_VERSION_1_1 = 'container CLI version 1.1.0 (build: release, commit: 5973b9c)'
/** Shell exit 127: the `container` binary is not on PATH. */
const cliAbsentError = () => Object.assign(new Error('sh: container: command not found'), { code: 127 })

describe('AppleContainerClient.getInfoFromRuntime', () => {
  it('treats status.state=running as running (Apple Container 1.x inspect shape)', async () => {
    mockExecWithPath.mockResolvedValue({
      stdout: JSON.stringify({
        status: { state: 'running', networks: [] },
        configuration: {
          publishedPorts: [{ containerPort: 3000, hostPort: 5001, proto: 'tcp' }],
        },
      }),
    })

    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect(client.getInfoFromRuntime()).resolves.toEqual({
      status: 'running',
      port: 5001,
    })
  })
})

describe('AppleContainerClient.getStats', () => {
  beforeEach(() => {
    mockExecWithPath.mockReset()
  })

  it('reads guest /proc/meminfo via container exec (Apple CLI has no stats)', async () => {
    mockExecWithPath.mockResolvedValue({
      stdout: 'MemTotal:        2000000 kB\nMemFree:          400000 kB\nMemAvailable:    1500000 kB\n',
      stderr: '',
    })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect(client.getStats()).resolves.toEqual({
      memoryUsageBytes: 500000 * 1024,
      memoryLimitBytes: 2000000 * 1024,
      memoryPercent: 25,
      cpuPercent: 0,
    })
    expect(mockExecWithPath).toHaveBeenCalledWith(
      'container exec superagent-abc123 cat /proc/meminfo',
      { timeoutMs: 5000 },
    )
  })

  it('returns null when exec fails so the health monitor skips the agent', async () => {
    mockExecWithPath.mockRejectedValue(new Error('container not running'))
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect(client.getStats()).resolves.toBeNull()
  })
})

describe('AppleContainerClient recovery hooks', () => {
  beforeEach(() => {
    mockExecWithPath.mockReset()
  })

  it('forceStop force-deletes the container VM, bounded', async () => {
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await (client as any).forceStop()
    expect(mockExecWithPath).toHaveBeenCalledWith('container delete --force superagent-abc123', { timeoutMs: 10_000 })
  })

  it('getLogs uses Apple\'s -n flag (Docker\'s --tail exits 64 on this CLI)', async () => {
    mockExecWithPath.mockResolvedValue({ stdout: 'boot ok\n', stderr: '' })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect(client.getLogs(30)).resolves.toBe('boot ok')
    expect(mockExecWithPath).toHaveBeenCalledWith('container logs -n 30 superagent-abc123')
  })

  it('removeCorruptImage clears the failed container record first; its absence never blocks the image delete', async () => {
    const calls: string[] = []
    mockExecWithPath.mockImplementation(async (cmd: string) => {
      calls.push(cmd)
      if (cmd.startsWith('container delete')) throw new Error('no such container')
      return { stdout: '', stderr: '' }
    })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await (client as any).removeCorruptImage('ghcr.io/x/agent:1')
    expect(calls).toEqual([
      'container delete --force superagent-abc123',
      `container image delete --force 'ghcr.io/x/agent:1'`,
    ])
    expect(mockExecWithPath).toHaveBeenCalledWith('container delete --force superagent-abc123', { timeoutMs: 10_000 })
  })

  it('collectStopFailureDiagnostics degrades failed probes to markers instead of throwing', async () => {
    mockExecWithPath.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith('container inspect')) throw new Error('inspect hung')
      return { stdout: 'ok', stderr: '' }
    })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    const diag = await (client as any).collectStopFailureDiagnostics('superagent-abc123')
    expect(diag.container_state).toMatch(/^probe_failed:/)
    expect(diag.containers_list).toBe('ok')
  })
})

describe('AppleContainerClient host talk-back (host.docker.internal is NXDOMAIN here)', () => {
  beforeEach(() => {
    resetAppleContainerClientForTests()
    mockExecSyncWithPath.mockReset()
  })

  it('routes host API + bridge IP through the default network gateway', () => {
    mockExecSyncWithPath.mockReturnValue(Buffer.from(JSON.stringify([{ status: { ipv4Gateway: '192.168.64.1' } }])))
    const client = new AppleContainerClient({ agentId: 'abc123' })
    expect(client.getHostApiBaseUrl()).toBe('http://192.168.64.1:47891')
    expect(client.getHostBridgeIp()).toBe('192.168.64.1')
    // Cached: one inspect for both calls.
    expect(mockExecSyncWithPath).toHaveBeenCalledOnce()
  })

  it('refuses host API URL when the gateway cannot be resolved (Docker fallback is NXDOMAIN here)', () => {
    mockExecSyncWithPath.mockImplementation(() => { throw new Error('network inspect failed') })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    expect(() => client.getHostApiBaseUrl()).toThrow(/host gateway is unreachable/i)
    expect(client.getHostBridgeIp()).toBeNull()
  })
})

describe('AppleContainerClient.isRunning', () => {
  beforeEach(() => {
    mockExecWithPath.mockReset()
  })

  it('requires a real API roundtrip — status passing while list fails reads as down', async () => {
    mockExecWithPath.mockImplementation(async (cmd: string) => {
      if (cmd === 'container list') throw new Error('api not answering')
      return { stdout: 'apiserver is running', stderr: '' }
    })
    await expect(AppleContainerClient.isRunning()).resolves.toBe(false)
    expect(mockExecWithPath).toHaveBeenCalledWith('container system status', { timeoutMs: 10_000 })
  })
})

describe('AppleContainerClient.handleRunError', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch

  beforeEach(() => {
    resetAppleContainerClientForTests()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: 'arm64', writable: true, configurable: true })
    mockExecSync.mockReturnValue(Buffer.from('26.0\n'))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: originalArch, writable: true, configurable: true })
    resetAppleContainerClientForTests()
  })

  it('restarts the runtime when the health probe fails, then retries the run', async () => {
    let listCalls = 0
    mockExecWithPath.mockImplementation(async (cmd: string) => {
      if (cmd === 'container list' && ++listCalls === 1) throw new Error('connection refused')
      if (cmd === 'container --version') return { stdout: CLI_VERSION_1_1, stderr: '' }
      return { stdout: '', stderr: '' }
    })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect((client as any).handleRunError(new Error('vm exited unexpectedly'))).resolves.toBe(true)
    expect(mockExecWithPath).toHaveBeenCalledWith(
      expect.stringMatching(/^container system start --enable-kernel-install --timeout \d+$/),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
  })

  it('does not restart a healthy runtime on an unrecognized run error', async () => {
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect((client as any).handleRunError(new Error('weird one-off'))).resolves.toBe(false)
    expect(mockExecWithPath.mock.calls.some(([cmd]) => String(cmd).includes('system start'))).toBe(false)
  })

  it('maps a killed run exec on a healthy runtime to a clear timeout error (dataless-mount hang guard)', async () => {
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
    const runError = Object.assign(new Error('Command failed: container run -d ...'), { killed: true, signal: 'SIGKILL' })
    const client = new AppleContainerClient({ agentId: 'abc123' })
    await expect((client as any).handleRunError(runError)).rejects.toThrow(/timed out.*iCloud/s)
    // killed is set only by the exec API's own timeout; an external SIGKILL
    // (killed: false) must NOT be diagnosed as the hang guard.
    const externalKill = Object.assign(new Error('Command failed: container run -d ...'), { killed: false, signal: 'SIGKILL' })
    await expect((client as any).handleRunError(externalKill)).resolves.toBe(false)
  })
})

describe('AppleContainerClient.isAvailable (version gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    { version: CLI_VERSION_1_1, expected: true, label: 'pinned 1.1.x' },
    { version: 'container CLI version 0.12.3 (build: release, commit: abc1234)', expected: false, label: 'pre-1.1 lacks system start --timeout' },
    { version: 'container CLI version 2.0.0 (build: release, commit: abc1234)', expected: false, label: 'future major is unproven' },
  ])('isAvailable=$expected for $label', async ({ version, expected }) => {
    mockExecWithPath.mockResolvedValue({ stdout: version, stderr: '' })
    await expect(AppleContainerClient.isAvailable()).resolves.toBe(expected)
  })
})

describe('AppleContainerClient.isEligible', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch

  beforeEach(() => {
    resetAppleContainerClientForTests()
    mockExecSync.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: originalArch, writable: true, configurable: true })
    resetAppleContainerClientForTests()
  })

  function setPlatformArch(platform: string, arch: string) {
    Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: arch, writable: true, configurable: true })
  }

  it.each([
    { platform: 'darwin', arch: 'arm64', version: '26.0', expected: true, label: 'arm64 macOS 26+' },
    { platform: 'darwin', arch: 'arm64', version: '15.4', expected: false, label: 'macOS < 26' },
  ])('isEligible=$expected for $label', ({ platform, arch, version, expected }) => {
    setPlatformArch(platform, arch)
    mockExecSync.mockReturnValue(Buffer.from(`${version}\n`))
    expect(AppleContainerClient.isEligible()).toBe(expected)
  })
})

describe('ensureAppleContainerReady', () => {
  const originalPlatform = process.platform
  const originalArch = process.arch
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetAppleContainerClientForTests()
    vi.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: 'arm64', writable: true, configurable: true })
    mockExecSync.mockReturnValue(Buffer.from('26.0\n'))
    mockIsAdminPrivilegeCancelError.mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error ?? '')
      return message.includes('User canceled') || message.includes('-128')
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true })
    Object.defineProperty(process, 'arch', { value: originalArch, writable: true, configurable: true })
    globalThis.fetch = originalFetch
    resetAppleContainerClientForTests()
  })

  it('skips download when CLI is already installed', async () => {
    // stdout is only read by the version probe; other commands ignore it.
    mockExecWithPath.mockResolvedValue({ stdout: CLI_VERSION_1_1, stderr: '' })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await ensureAppleContainerReady(undefined, { allowInstall: true })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
    expect(mockExecWithPath).toHaveBeenCalledWith(
      expect.stringMatching(/^container system start --enable-kernel-install --timeout \d+$/),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
  })

  it('refuses first-install without allowInstall', async () => {
    mockExecWithPath.mockRejectedValue(cliAbsentError())

    await expect(ensureAppleContainerReady()).rejects.toThrow(/Click Install/i)
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
  })

  it('refuses an unsupported installed version instead of running a start it cannot survive', async () => {
    mockExecWithPath.mockResolvedValue({ stdout: 'container CLI version 0.12.3 (build: release, commit: abc1234)', stderr: '' })

    await expect(ensureAppleContainerReady()).rejects.toThrow(/not supported.*Install to update/i)
    expect(mockExecWithPath.mock.calls.some(([cmd]) => String(cmd).includes('system start'))).toBe(false)
  })

  it('first-install: download, verify, elevate with rehash, start + progress', async () => {
    mockExecWithPath.mockImplementation(async (cmd: string) => {
      if (cmd === 'container --version') throw cliAbsentError()
      return { stdout: '', stderr: '' }
    })
    appleContainerProvisionIO.downloadToFile = vi.fn(
      async (_url: string, _dest: string, onBytes?: (downloaded: number, total: number | null) => void) => {
        onBytes?.(50, 100)
        onBytes?.(100, 100)
      },
    )
    appleContainerProvisionIO.hashFileSha256 = vi.fn().mockResolvedValue(APPLE_CONTAINER_PKG_SHA256)
    mockRunWithAdminPrivileges.mockResolvedValue(undefined)

    const events: Array<{ status: string; percent: number | null }> = []
    await ensureAppleContainerReady((p) => events.push(p), { allowInstall: true })

    expect(appleContainerProvisionIO.downloadToFile).toHaveBeenCalledOnce()
    expect(mockRunWithAdminPrivileges).toHaveBeenCalledOnce()
    const elevateCmd = mockRunWithAdminPrivileges.mock.calls[0]?.[0] as string
    // macOS mktemp only randomizes trailing X's; .pkg must not follow the template.
    expect(elevateCmd).toContain('/usr/bin/mktemp -d /tmp/superagent-container-XXXXXX)')
    expect(elevateCmd).not.toContain('XXXXXX.pkg')
    expect(elevateCmd).toContain('TMP="$DIR/installer.pkg"')
    expect(elevateCmd).toContain('trap ')
    expect(elevateCmd).toContain('/usr/bin/shasum -a 256')
    expect(elevateCmd).toContain('/usr/sbin/installer -pkg')
    expect(elevateCmd).toContain(APPLE_CONTAINER_PKG_SHA256)
    expect(mockExecWithPath).toHaveBeenCalledWith(
      expect.stringMatching(/^container system start --enable-kernel-install --timeout \d+$/),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
    expect(events.some((e) => e.status.includes('Downloading') && e.percent === 50)).toBe(true)
    expect(events.some((e) => e.status.includes('Verifying') && e.percent === null)).toBe(true)
    // After download, never invent a rising overall percent
    const afterDownload = events.slice(events.findIndex((e) => e.status.includes('Verifying')))
    expect(afterDownload.every((e) => e.percent === null)).toBe(true)
  })

  it('refuses to provision on ineligible machines', async () => {
    Object.defineProperty(process, 'arch', { value: 'x64', writable: true, configurable: true })
    resetAppleContainerClientForTests()

    await expect(ensureAppleContainerReady(undefined, { allowInstall: true })).rejects.toThrow(/Apple silicon|macOS 26/i)
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
  })

  it('never elevates when downloaded digest mismatches', async () => {
    mockExecWithPath.mockRejectedValue(cliAbsentError())
    const badBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not-the-installer'))
        controller.close()
      },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: badBody,
    }) as unknown as typeof fetch

    await expect(ensureAppleContainerReady(undefined, { allowInstall: true })).rejects.toThrow(/integrity check/i)
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
  })

  it('maps admin cancel to a recoverable error', async () => {
    mockExecWithPath.mockRejectedValue(cliAbsentError())
    appleContainerProvisionIO.downloadToFile = vi.fn().mockResolvedValue(undefined)
    appleContainerProvisionIO.hashFileSha256 = vi.fn().mockResolvedValue(APPLE_CONTAINER_PKG_SHA256)
    mockRunWithAdminPrivileges.mockRejectedValue(new Error('User canceled. (-128)'))

    await expect(ensureAppleContainerReady(undefined, { allowInstall: true })).rejects.toThrow(/cancelled|canceled/i)
    expect(mockRunWithAdminPrivileges.mock.calls[0]?.[0]).not.toContain('http')
  })

  it('mutex serializes concurrent ensure calls', async () => {
    let resolveVersion: ((v: { stdout: string; stderr: string }) => void) | undefined
    let versionCalls = 0
    mockExecWithPath.mockImplementation((cmd: string) => {
      if (cmd === 'container --version') {
        versionCalls++
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          resolveVersion = resolve
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const p1 = ensureAppleContainerReady(undefined, { allowInstall: true })
    const p2 = ensureAppleContainerReady(undefined, { allowInstall: true })
    expect(versionCalls).toBe(1)

    resolveVersion?.({ stdout: CLI_VERSION_1_1, stderr: '' })
    await Promise.all([p1, p2])
    expect(versionCalls).toBe(1)
  })
})
