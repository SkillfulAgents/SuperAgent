import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing the module under test
// ============================================================================

const mockStopLimaVm = vi.fn()
const mockEnsureLimaReady = vi.fn()
const mockReconcileLimaState = vi.fn().mockResolvedValue(false)

vi.mock('./lima-container-client', () => ({
  LimaContainerClient: {
    isEligible: vi.fn(() => true),
    isAvailable: vi.fn(() => Promise.resolve(true)),
    reconcileRuntimeState: (...args: unknown[]) => mockReconcileLimaState(...args),
    isRunning: vi.fn(() => Promise.resolve(true)),
  },
  getNerdctlWrapperPath: vi.fn(() => '/mock/nerdctl'),
  ensureLimaReady: (...args: unknown[]) => mockEnsureLimaReady(...args),
  stopLimaVm: (...args: unknown[]) => mockStopLimaVm(...args),
}))

vi.mock('./docker-container-client', () => ({
  DockerContainerClient: {
    isEligible: vi.fn(() => true),
    isAvailable: vi.fn(() => Promise.resolve(true)),
    isRunning: vi.fn(() => Promise.resolve(true)),
  },
}))

vi.mock('./podman-container-client', () => ({
  PodmanContainerClient: {
    isEligible: vi.fn(() => true),
    isAvailable: vi.fn(() => Promise.resolve(true)),
    isRunning: vi.fn(() => Promise.resolve(true)),
  },
}))

vi.mock('./apple-container-client', () => ({
  AppleContainerClient: {
    isEligible: vi.fn(() => false),
    isAvailable: vi.fn(() => Promise.resolve(false)),
    isRunning: vi.fn(() => Promise.resolve(false)),
  },
}))

const mockStopWSL2Distro = vi.fn()
const mockEnsureWSL2Ready = vi.fn()

vi.mock('./wsl2-container-client', () => ({
  WSL2ContainerClient: {
    isEligible: vi.fn(() => false),
    isAvailable: vi.fn(() => Promise.resolve(false)),
    isRunning: vi.fn(() => Promise.resolve(false)),
  },
  getWSL2NerdctlWrapperPath: vi.fn(() => 'C:\\mock\\wsl-nerdctl.cmd'),
  ensureWSL2Ready: (...args: unknown[]) => mockEnsureWSL2Ready(...args),
  stopWSL2Distro: (...args: unknown[]) => mockStopWSL2Distro(...args),
}))

vi.mock('./mock-container-client', () => ({
  MockContainerClient: vi.fn(),
}))

const mockExecWithPath = vi.fn()
const mockSpawnWithPath = vi.fn()
vi.mock('./base-container-client', () => ({
  execWithPath: (...args: unknown[]) => mockExecWithPath(...args),
  spawnWithPath: (...args: unknown[]) => mockSpawnWithPath(...args),
  AGENT_CONTAINER_PATH: '/mock/agent-container',
}))

vi.mock('fs', () => ({
  default: { existsSync: vi.fn(() => false) },
  existsSync: vi.fn(() => false),
}))

const mockGetSettings = vi.fn()
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}))

vi.mock('os', () => ({
  platform: vi.fn(() => 'darwin'),
}))

// ============================================================================
// Import module under test — AFTER mocks
// ============================================================================

import {
  clearRunnerAvailabilityCache,
  reconcileRunnerState,
  restartRunner,
  shutdownActiveRunner,
} from './client-factory'

// ============================================================================
// Tests
// ============================================================================

describe('shutdownActiveRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls stopLimaVm when configured runner is lima', async () => {
    mockGetSettings.mockReturnValue({
      container: { containerRunner: 'lima' },
    })
    mockStopLimaVm.mockResolvedValue(undefined)

    await shutdownActiveRunner()

    expect(mockStopLimaVm).toHaveBeenCalledOnce()
  })

  it('is a no-op for docker (no shutdownRuntime)', async () => {
    mockGetSettings.mockReturnValue({
      container: { containerRunner: 'docker' },
    })

    await shutdownActiveRunner()

    expect(mockStopLimaVm).not.toHaveBeenCalled()
    expect(mockExecWithPath).not.toHaveBeenCalled()
  })

  it('is a no-op for podman (no shutdownRuntime)', async () => {
    mockGetSettings.mockReturnValue({
      container: { containerRunner: 'podman' },
    })

    await shutdownActiveRunner()

    expect(mockStopLimaVm).not.toHaveBeenCalled()
  })

  it('calls stopWSL2Distro when configured runner is wsl2', async () => {
    mockGetSettings.mockReturnValue({
      container: { containerRunner: 'wsl2' },
    })
    mockStopWSL2Distro.mockResolvedValue(undefined)

    await shutdownActiveRunner()

    expect(mockStopWSL2Distro).toHaveBeenCalledOnce()
  })
})

describe('restartRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls stopLimaVm then ensureLimaReady for lima runner', async () => {
    mockStopLimaVm.mockResolvedValue(undefined)
    mockEnsureLimaReady.mockResolvedValue(undefined)

    const result = await restartRunner('lima')

    expect(mockStopLimaVm).toHaveBeenCalledOnce()
    expect(mockEnsureLimaReady).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('continues to start even when shutdown throws', async () => {
    mockStopLimaVm.mockRejectedValue(new Error('VM not running'))
    mockEnsureLimaReady.mockResolvedValue(undefined)

    const result = await restartRunner('lima')

    // Should still attempt start
    expect(mockEnsureLimaReady).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('returns failure when start fails after restart', async () => {
    mockStopLimaVm.mockResolvedValue(undefined)
    mockEnsureLimaReady.mockRejectedValue(new Error('boot failed'))

    const result = await restartRunner('lima')

    expect(result.success).toBe(false)
    expect(result.message).toContain('boot failed')
  })

  it('does not call shutdown for docker (no shutdownRuntime)', async () => {
    mockExecWithPath.mockResolvedValue({ stdout: '', stderr: '' })

    // Docker on macOS — startRunner will try to open Docker Desktop
    await restartRunner('docker')

    expect(mockStopLimaVm).not.toHaveBeenCalled()
  })

  it('calls stopWSL2Distro then ensureWSL2Ready for wsl2 runner', async () => {
    mockStopWSL2Distro.mockResolvedValue(undefined)
    mockEnsureWSL2Ready.mockResolvedValue(undefined)

    const result = await restartRunner('wsl2')

    expect(mockStopWSL2Distro).toHaveBeenCalledOnce()
    expect(mockEnsureWSL2Ready).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('continues to start wsl2 even when shutdown throws', async () => {
    mockStopWSL2Distro.mockRejectedValue(new Error('WSL2 not running'))
    mockEnsureWSL2Ready.mockResolvedValue(undefined)

    const result = await restartRunner('wsl2')

    expect(mockEnsureWSL2Ready).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })

  it('returns failure when wsl2 start fails after restart', async () => {
    mockStopWSL2Distro.mockResolvedValue(undefined)
    mockEnsureWSL2Ready.mockRejectedValue(new Error('containerd failed'))

    const result = await restartRunner('wsl2')

    expect(result.success).toBe(false)
    expect(result.message).toContain('containerd failed')
  })
})

describe('reconcileRunnerState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRunnerAvailabilityCache()
  })

  it('calls reconcileRuntimeState for lima runner', async () => {
    mockReconcileLimaState.mockResolvedValue(true)

    const rebuilt = await reconcileRunnerState('lima')

    expect(mockReconcileLimaState).toHaveBeenCalledOnce()
    expect(rebuilt).toBe(true)
  })

  it('returns false for runners without reconcileRuntimeState', async () => {
    const rebuilt = await reconcileRunnerState('docker')

    expect(rebuilt).toBe(false)
    expect(mockReconcileLimaState).not.toHaveBeenCalled()
  })
})

// ============================================================================
// ANSI stripping and image pull progress parsing
// These are tested via the pullImage function's internal logic.
// Since pullImage spawns a process, we test the patterns directly.
// ============================================================================

describe('ANSI stripping regex', () => {
  // The regex used in pullImage: /\x1b\[[0-9;]*[A-Za-z]/g
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

  it('strips basic color codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text')
  })

  it('strips bold/underline codes', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[22m normal')).toBe('bold normal')
  })

  it('strips 256-color codes', () => {
    expect(stripAnsi('\x1b[38;5;196mred\x1b[0m')).toBe('red')
  })

  it('strips cursor movement codes', () => {
    expect(stripAnsi('\x1b[2Aup two lines')).toBe('up two lines')
  })

  it('strips clear line codes', () => {
    expect(stripAnsi('\x1b[2Kcleared line')).toBe('cleared line')
  })

  it('preserves plain text unchanged', () => {
    expect(stripAnsi('no ansi here')).toBe('no ansi here')
  })

  it('strips multiple codes in one string', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mbold red\x1b[0m normal')).toBe('bold red normal')
  })
})

describe('image pull progress patterns', () => {
  // Docker format: "abc123def: Pull complete"
  const dockerLayerPattern = /^([a-f0-9]+):\s+(.+)$/i
  const dockerCompletedStatuses = ['pull complete', 'already exists']

  // nerdctl format: "layer-sha256:abc123: done"
  const nerdctlItemPattern = /^((?:layer|manifest|config|index)-sha256:[a-f0-9]+):\s+(\w+)/i
  const nerdctlCompletedStatuses = ['done', 'exists']

  describe('Docker format', () => {
    it('matches layer progress line', () => {
      const match = 'abc123def456: Downloading'.match(dockerLayerPattern)
      expect(match).toBeTruthy()
      expect(match![1]).toBe('abc123def456')
      expect(match![2]).toBe('Downloading')
    })

    it('identifies completed layers', () => {
      const match = 'abc123: Pull complete'.match(dockerLayerPattern)
      expect(match).toBeTruthy()
      const status = match![2].toLowerCase()
      expect(dockerCompletedStatuses.some((s) => status.startsWith(s))).toBe(true)
    })

    it('identifies already exists layers', () => {
      const match = 'def456: Already exists'.match(dockerLayerPattern)
      expect(match).toBeTruthy()
      const status = match![2].toLowerCase()
      expect(dockerCompletedStatuses.some((s) => status.startsWith(s))).toBe(true)
    })

    it('does not match non-layer lines', () => {
      expect('Pulling from library/alpine'.match(dockerLayerPattern)).toBeNull()
    })
  })

  describe('nerdctl format', () => {
    it('matches layer-sha256 line', () => {
      const match = 'layer-sha256:abc123def456: done'.match(nerdctlItemPattern)
      expect(match).toBeTruthy()
      expect(match![1]).toBe('layer-sha256:abc123def456')
      expect(match![2]).toBe('done')
    })

    it('matches manifest-sha256 line', () => {
      const match = 'manifest-sha256:deadbeef: done'.match(nerdctlItemPattern)
      expect(match).toBeTruthy()
      expect(match![1]).toBe('manifest-sha256:deadbeef')
    })

    it('matches config-sha256 line', () => {
      const match = 'config-sha256:cafebabe: exists'.match(nerdctlItemPattern)
      expect(match).toBeTruthy()
      expect(nerdctlCompletedStatuses.includes(match![2].toLowerCase())).toBe(true)
    })

    it('identifies completed items', () => {
      const match = 'layer-sha256:abc123: done'.match(nerdctlItemPattern)
      expect(nerdctlCompletedStatuses.includes(match![2].toLowerCase())).toBe(true)
    })

    it('identifies in-progress items', () => {
      const match = 'layer-sha256:abc123: downloading'.match(nerdctlItemPattern)
      expect(match).toBeTruthy()
      expect(nerdctlCompletedStatuses.includes(match![2].toLowerCase())).toBe(false)
    })
  })

  describe('progress calculation', () => {
    it('computes correct percentage from layer counts', () => {
      const allLayers = new Set(['a', 'b', 'c', 'd'])
      const completedLayers = new Set(['a', 'b', 'c'])
      const percent = Math.round((completedLayers.size / allLayers.size) * 100)
      expect(percent).toBe(75)
    })

    it('returns null percent when no layers detected', () => {
      const total = 0
      const percent = total > 0 ? Math.round((0 / total) * 100) : null
      expect(percent).toBeNull()
    })
  })
})
