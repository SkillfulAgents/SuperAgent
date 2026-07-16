import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

const mockCheckCommandAvailable = vi.fn()
const mockExecWithPath = vi.fn()
vi.mock('./base-container-client', () => ({
  BaseContainerClient: class {
    config: { agentId: string }
    constructor(config: { agentId: string }) {
      this.config = config
    }
    getContainerName() {
      return `superagent-${this.config.agentId}`
    }
  },
  checkCommandAvailable: (...args: unknown[]) => mockCheckCommandAvailable(...args),
  execWithPath: (...args: unknown[]) => mockExecWithPath(...args),
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

import {
  AppleContainerClient,
  APPLE_CONTAINER_PKG_SHA256,
  appleContainerProvisionIO,
  ensureAppleContainerReady,
  resetAppleContainerClientForTests,
} from './apple-container-client'

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
    mockCheckCommandAvailable.mockResolvedValue(true)
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await ensureAppleContainerReady(undefined, { allowInstall: true })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
    expect(mockExecWithPath).toHaveBeenCalledWith('container system start --enable-kernel-install')
  })

  it('refuses first-install without allowInstall', async () => {
    mockCheckCommandAvailable.mockResolvedValue(false)

    await expect(ensureAppleContainerReady()).rejects.toThrow(/Click Install/i)
    expect(mockRunWithAdminPrivileges).not.toHaveBeenCalled()
  })

  it('first-install: download, verify, elevate with rehash, start + progress', async () => {
    mockCheckCommandAvailable.mockResolvedValue(false)
    appleContainerProvisionIO.downloadToFile = vi.fn(
      async (_url: string, _dest: string, onBytes?: (downloaded: number, total: number | null) => void) => {
        onBytes?.(50, 100)
        onBytes?.(100, 100)
      },
    )
    appleContainerProvisionIO.hashFileSha256 = vi.fn().mockResolvedValue(APPLE_CONTAINER_PKG_SHA256)
    mockRunWithAdminPrivileges.mockResolvedValue(undefined)
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })

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
    expect(mockExecWithPath).toHaveBeenCalledWith('container system start --enable-kernel-install')
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
    mockCheckCommandAvailable.mockResolvedValue(false)
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
    mockCheckCommandAvailable.mockResolvedValue(false)
    appleContainerProvisionIO.downloadToFile = vi.fn().mockResolvedValue(undefined)
    appleContainerProvisionIO.hashFileSha256 = vi.fn().mockResolvedValue(APPLE_CONTAINER_PKG_SHA256)
    mockRunWithAdminPrivileges.mockRejectedValue(new Error('User canceled. (-128)'))

    await expect(ensureAppleContainerReady(undefined, { allowInstall: true })).rejects.toThrow(/cancelled|canceled/i)
    expect(mockRunWithAdminPrivileges.mock.calls[0]?.[0]).not.toContain('http')
  })

  it('mutex serializes concurrent ensure calls', async () => {
    let resolveAvailable: ((v: boolean) => void) | undefined
    let availableCalls = 0
    mockCheckCommandAvailable.mockImplementation(() => {
      availableCalls++
      return new Promise<boolean>((resolve) => {
        resolveAvailable = resolve
      })
    })
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })

    const p1 = ensureAppleContainerReady(undefined, { allowInstall: true })
    const p2 = ensureAppleContainerReady(undefined, { allowInstall: true })
    expect(availableCalls).toBe(1)

    resolveAvailable?.(true)
    await Promise.all([p1, p2])
    expect(availableCalls).toBe(1)
  })
})
