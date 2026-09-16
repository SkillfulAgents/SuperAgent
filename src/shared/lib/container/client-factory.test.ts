import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

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

const mockEnsureAppleContainerReady = vi.fn()

vi.mock('./apple-container-client', () => ({
  AppleContainerClient: {
    // Eligible at module load so apple is in SUPPORTED_RUNNERS for availability tests.
    isEligible: vi.fn(() => true),
    isAvailable: vi.fn(() => Promise.resolve(false)),
    isRunning: vi.fn(() => Promise.resolve(false)),
  },
  ensureAppleContainerReady: (...args: unknown[]) => mockEnsureAppleContainerReady(...args),
}))

const mockStopWSL2Distro = vi.fn()
const mockEnsureWSL2Ready = vi.fn()
const mockKillWSL2PullProcesses = vi.fn()

vi.mock('./wsl2-container-client', () => ({
  WSL2ContainerClient: {
    isEligible: vi.fn(() => false),
    isAvailable: vi.fn(() => Promise.resolve(false)),
    isRunning: vi.fn(() => Promise.resolve(false)),
  },
  getWSL2NerdctlWrapperPath: vi.fn(() => 'C:\\mock\\wsl-nerdctl.cmd'),
  ensureWSL2Ready: (...args: unknown[]) => mockEnsureWSL2Ready(...args),
  stopWSL2Distro: (...args: unknown[]) => mockStopWSL2Distro(...args),
  killWSL2PullProcesses: (...args: unknown[]) => mockKillWSL2PullProcesses(...args),
}))

vi.mock('./mock-container-client', () => ({
  MockContainerClient: vi.fn(),
}))

vi.mock('./platform-k8s-runtime', () => ({
  PlatformK8sRuntimeClient: class {
    static isEligible() { return false }
    static async isAvailable() { return false }
    static async isRunning() { return false }
  },
}))

vi.mock('./lambda-microvm-runtime', () => ({
  LambdaMicroVmRuntimeClient: class {
    static isEligible() { return false }
    static async isAvailable() { return false }
    static async isRunning() { return false }
  },
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

const mockCaptureException = vi.fn()
const mockCaptureMessage = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  addErrorBreadcrumb: vi.fn(),
}))

// ============================================================================
// Import module under test — AFTER mocks
// ============================================================================

import {
  checkAllRunnersAvailability,
  classifyImageCheckOutput,
  clearRunnerAvailabilityCache,
  IMAGE_CHECK_MARKER,
  IMAGE_CHECK_TIMEOUT_MS,
  pullImage,
  PULL_STALL_TIMEOUT_MS,
  KILL_STALLED_PULL_TIMEOUT_MS,
  reconcileRunnerState,
  restartRunner,
  shutdownActiveRunner,
  startRunner,
} from './client-factory'
import { AppleContainerClient } from './apple-container-client'

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

describe('startRunner apple-container', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRunnerAvailabilityCache()
    mockEnsureAppleContainerReady.mockResolvedValue(undefined)
  })

  it('delegates to ensureAppleContainerReady with allowInstall', async () => {
    const result = await startRunner('apple-container', undefined, { allowInstall: true })

    expect(mockEnsureAppleContainerReady).toHaveBeenCalledWith(undefined, { allowInstall: true })
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/running/i)
  })

  it('auto-start path does not allow install', async () => {
    await startRunner('apple-container')

    expect(mockEnsureAppleContainerReady).toHaveBeenCalledWith(undefined, { allowInstall: false })
  })
})

describe('checkAllRunnersAvailability apple-container canStart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRunnerAvailabilityCache()
    vi.mocked(AppleContainerClient.isEligible).mockReturnValue(true)
  })

  it('sets canStart true when CLI missing (provisionable)', async () => {
    vi.mocked(AppleContainerClient.isAvailable).mockResolvedValue(false)
    vi.mocked(AppleContainerClient.isRunning).mockResolvedValue(false)

    const results = await checkAllRunnersAvailability()
    const apple = results.find((r) => r.runner === 'apple-container')

    expect(apple).toMatchObject({
      installed: false,
      running: false,
      available: false,
      canStart: true,
    })
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

// ============================================================================
// pullImage stall watchdog — silence beyond pullStallTimeoutMs kills the pull
// (host proc + runner-side processes) and rejects so the caller can retry.
// Only runners that opt in (nerdctl-based) have a timeout; docker/podman are
// legitimately silent for minutes mid-layer and must never be killed.
// ============================================================================

describe('pullImage stall watchdog', () => {
  class FakePullProc extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    kill = vi.fn()
  }

  let proc: FakePullProc

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    proc = new FakePullProc()
    // A successful pull is followed by the integrity-check container (a
    // `run`); hand that spawn its own process that passes straight away.
    mockSpawnWithPath.mockImplementation((_cli: string, args: string[]) => {
      if (args[0] !== 'run') return proc
      const check = new FakePullProc()
      queueMicrotask(() => {
        check.stdout.emit('data', Buffer.from(`${IMAGE_CHECK_MARKER} 139 package.json files checked, 0 damaged\n`))
        check.emit('close', 0)
      })
      return check
    })
    mockKillWSL2PullProcesses.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('kills a wsl2 pull and rejects after prolonged output silence', async () => {
    const promise = pullImage('wsl2', 'ghcr.io/acme/agent:stall-1')
    const assertion = expect(promise).rejects.toThrow('Image pull stalled')

    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1)
    await assertion

    expect(mockKillWSL2PullProcesses).toHaveBeenCalledOnce()
    expect(proc.kill).toHaveBeenCalled()
    expect(mockCaptureException).toHaveBeenCalledOnce()
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      tags: { component: 'container', operation: 'image-pull-stall' },
    })
  })

  it('resets the stall timer whenever the CLI produces output', async () => {
    const promise = pullImage('wsl2', 'ghcr.io/acme/agent:stall-2')

    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS - 1000)
    proc.stdout.emit('data', Buffer.from('layer-sha256:abc123: downloading\n'))
    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS - 1000)
    expect(proc.kill).not.toHaveBeenCalled()

    proc.emit('close', 0)
    await expect(promise).resolves.toBeUndefined()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('does not arm a watchdog for docker (silence is normal mid-layer)', async () => {
    const promise = pullImage('docker', 'ghcr.io/acme/agent:stall-3')

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(proc.kill).not.toHaveBeenCalled()
    expect(mockKillWSL2PullProcesses).not.toHaveBeenCalled()

    proc.emit('close', 0)
    await expect(promise).resolves.toBeUndefined()
  })

  it('does not double-report when the killed process exits after the stall', async () => {
    const promise = pullImage('wsl2', 'ghcr.io/acme/agent:stall-4')
    const assertion = expect(promise).rejects.toThrow('Image pull stalled')

    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1)
    proc.emit('close', 1)
    await assertion

    expect(mockCaptureException).toHaveBeenCalledOnce()
  })

  it('settles the pull even when killStalledPull hangs forever', async () => {
    // Unresponsive WSL: the cleanup promise never settles
    mockKillWSL2PullProcesses.mockReturnValue(new Promise(() => {}))

    const promise = pullImage('wsl2', 'ghcr.io/acme/agent:stall-6')
    const assertion = expect(promise).rejects.toThrow('Image pull stalled')

    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1)
    // Pull must not be settled yet — cleanup is still within its time cap
    expect(proc.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(KILL_STALLED_PULL_TIMEOUT_MS + 1)
    await assertion
    expect(proc.kill).toHaveBeenCalled()
  })

  it('rejects with the stall error even when killStalledPull fails', async () => {
    mockKillWSL2PullProcesses.mockRejectedValue(new Error('WSL has terminated'))

    const promise = pullImage('wsl2', 'ghcr.io/acme/agent:stall-7')
    const assertion = expect(promise).rejects.toThrow('Image pull stalled')

    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1)
    await assertion
    expect(proc.kill).toHaveBeenCalled()
  })

  it('still rejects with the exit-code error when a wsl2 pull fails before the timeout', async () => {
    const promise = pullImage('wsl2', 'ghcr.io/acme/agent:stall-5')
    const assertion = expect(promise).rejects.toThrow('Image pull failed with exit code 1')

    proc.emit('close', 1)
    await assertion

    expect(mockKillWSL2PullProcesses).not.toHaveBeenCalled()
  })
})

// ============================================================================
// pullImage integrity check — a pull verifies layer digests on download but
// not the unpack; a file that lands truncated on a strained disk makes the
// image fail every start until it is deleted by hand. Right after the pull a
// throwaway container parses every package.json under /app/node_modules and
// loads the boot-time modules; a damaged image is deleted and pulled once
// more, a second damaged copy fails the pull with the damaged copy removed.
// ============================================================================

describe('classifyImageCheckOutput', () => {
  it('reads the summary line', () => {
    expect(classifyImageCheckOutput(`${IMAGE_CHECK_MARKER} 139 package.json files checked, 0 damaged`)).toBe('ok')
    expect(classifyImageCheckOutput(`damaged /app/node_modules/hono/package.json\n${IMAGE_CHECK_MARKER} 139 package.json files checked, 1 damaged`)).toBe('damaged')
  })

  it('recognises the server crash signatures when node died before the summary', () => {
    expect(classifyImageCheckOutput('Error: Invalid package config /app/node_modules/hono/package.json.\n  code: ERR_INVALID_PACKAGE_CONFIG')).toBe('damaged')
    expect(classifyImageCheckOutput("Error: Cannot find module '/app/dist/server.js'")).toBe('damaged')
    expect(classifyImageCheckOutput('/app/node_modules/hono/dist/cjs/index.js:412\n  foo(\n\nSyntaxError: Unexpected end of input')).toBe('damaged')
  })

  it('is inconclusive when the check could not run', () => {
    expect(classifyImageCheckOutput('')).toBe('inconclusive')
    expect(classifyImageCheckOutput('docker: Error response from daemon: dial unix /var/run/docker.sock: connect: no such file')).toBe('inconclusive')
    expect(classifyImageCheckOutput('Error: unknown flag: --entrypoint')).toBe('inconclusive')
    // A workspace file is user data, not image content.
    expect(classifyImageCheckOutput('Error: Invalid package config /workspace/app/package.json.')).toBe('inconclusive')
  })
})

describe('pullImage integrity check', () => {
  class FakeProc extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    kill = vi.fn()
    constructor(public readonly args: string[]) {
      super()
    }
  }

  const IMAGE = 'ghcr.io/acme/agent:1.0.0'
  const OK_LINE = `${IMAGE_CHECK_MARKER} 139 package.json files checked, 0 damaged\n`
  const DAMAGED_LINES = `damaged /app/node_modules/hono/package.json\n${IMAGE_CHECK_MARKER} 139 package.json files checked, 1 damaged\n`

  let spawned: FakeProc[]
  // Scripted outcomes for successive integrity-check containers.
  let checkScript: Array<'ok' | 'damaged' | 'silent' | 'hang'>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    spawned = []
    checkScript = []
    mockKillWSL2PullProcesses.mockResolvedValue(undefined)
    mockSpawnWithPath.mockImplementation((_cli: string, args: string[]) => {
      const proc = new FakeProc(args)
      spawned.push(proc)
      queueMicrotask(() => {
        if (args[0] === 'pull') {
          proc.emit('close', 0)
        } else if (args[0] === 'run') {
          const outcome = checkScript.shift() ?? 'ok'
          if (outcome === 'ok') {
            proc.stdout.emit('data', Buffer.from(OK_LINE))
            proc.emit('close', 0)
          } else if (outcome === 'damaged') {
            proc.stdout.emit('data', Buffer.from(DAMAGED_LINES))
            proc.emit('close', 1)
          } else if (outcome === 'silent') {
            proc.stderr.emit('data', Buffer.from('docker: Error response from daemon: something unrelated\n'))
            proc.emit('close', 125)
          }
          // 'hang': never closes — the timeout has to settle it.
        } else {
          proc.emit('close', 0)
        }
      })
      return proc
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const argsOf = (procs: FakeProc[]) => procs.map((p) => p.args[0])
  const checkProcs = () => spawned.filter((p) => p.args[0] === 'run')

  it('runs the check in a throwaway container of the pulled image, without a shell in the way', async () => {
    await pullImage('docker', IMAGE)

    expect(argsOf(spawned)).toEqual(['pull', 'run'])
    const [check] = checkProcs()
    expect(check.args).toEqual([
      'run', '--rm',
      '-e', expect.stringMatching(/^IMAGE_CHECK=[A-Za-z0-9+/=]+$/),
      '--entrypoint', 'node',
      IMAGE,
      '-e', "eval(Buffer.from(process.env.IMAGE_CHECK,'base64').toString())",
    ])
    // The script itself never touches a shell: it rides base64 in the env var.
    const encoded = check.args[3].slice('IMAGE_CHECK='.length)
    const script = Buffer.from(encoded, 'base64').toString('utf8')
    expect(script).toContain("walk('/app/node_modules')")
    expect(script).toContain("require('hono')")
    expect(script).toContain("require.resolve('/app/dist/server.js')")
    expect(mockCaptureMessage).not.toHaveBeenCalled()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('deletes a damaged image and pulls it again', async () => {
    checkScript = ['damaged', 'ok']

    await expect(pullImage('docker', IMAGE)).resolves.toBeUndefined()

    expect(argsOf(spawned)).toEqual(['pull', 'run', 'rmi', 'pull', 'run'])
    expect(spawned[2].args).toEqual(['rmi', '-f', IMAGE])
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Freshly pulled image is damaged; removing and pulling again',
      expect.objectContaining({ level: 'warning' })
    )
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('fails the pull, with the damaged copy removed, when the second download is damaged too', async () => {
    checkScript = ['damaged', 'damaged']

    const failure = await pullImage('docker', IMAGE).then(
      () => { throw new Error('expected the pull to fail') },
      (err: Error) => err
    )
    expect(failure.message).toMatch(/downloaded damaged twice/)
    // Marked so start()'s catch does not report the same failure twice.
    expect(failure).toMatchObject({ sentryCaptured: true })

    // No third pull, and the damaged copy does not linger to be mistaken for
    // a working image by the caller's "did it appear concurrently?" re-check.
    expect(argsOf(spawned)).toEqual(['pull', 'run', 'rmi', 'pull', 'run', 'rmi'])
    expect(mockCaptureException).toHaveBeenCalledOnce()
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      tags: { component: 'container', operation: 'image-integrity' },
    })
  })

  it('lets the pull succeed when the check cannot run at all', async () => {
    checkScript = ['silent']

    await expect(pullImage('docker', IMAGE)).resolves.toBeUndefined()

    expect(argsOf(spawned)).toEqual(['pull', 'run'])
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Image integrity check inconclusive after pull',
      expect.objectContaining({ level: 'info' })
    )
  })

  it('kills a hung check after the timeout and treats it as inconclusive', async () => {
    checkScript = ['hang']

    const promise = pullImage('docker', IMAGE)
    await vi.advanceTimersByTimeAsync(IMAGE_CHECK_TIMEOUT_MS + 1)
    await expect(promise).resolves.toBeUndefined()

    expect(checkProcs()[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Image integrity check inconclusive after pull',
      expect.objectContaining({ extra: expect.objectContaining({ output: expect.stringContaining('timed out') }) })
    )
  })

  it('uses `image delete` for the Apple runner, which has no rmi', async () => {
    checkScript = ['damaged', 'ok']

    await pullImage('apple-container', IMAGE)

    const removal = spawned.find((p) => p.args[0] === 'image' && p.args[1] === 'delete')
    expect(removal?.args).toEqual(['image', 'delete', '--force', IMAGE])
  })

  it('does not run the check when the pull itself failed', async () => {
    mockSpawnWithPath.mockImplementation((_cli: string, args: string[]) => {
      const proc = new FakeProc(args)
      spawned.push(proc)
      queueMicrotask(() => proc.emit('close', 1))
      return proc
    })

    await expect(pullImage('docker', IMAGE)).rejects.toThrow(/Image pull failed/)
    expect(argsOf(spawned)).toEqual(['pull'])
  })
})
