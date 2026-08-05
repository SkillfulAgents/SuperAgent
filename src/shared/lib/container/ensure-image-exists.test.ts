import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// ensureImageExists() — pull-vs-build decision and runtime discrimination.
//
// `image inspect` fails both when the image is missing (healthy runtime) and
// when the runtime is unreachable (wedged Lima VM → ssh exit 255). The old
// code treated every inspect failure as image-missing and ran a bare
// `<runner> build`, which is doomed in packaged apps (no build context; the
// bundled Lima VM has no buildkit → "buildctl not found in $PATH") and doomed
// on a wedged VM (exit 255 with empty stderr).
//
// The fixed path must:
//   - pull from the registry when there is no local build context
//   - build only in dev (local agent-container context exists)
//   - rethrow runtime-unreachable instead of attempting a create, so
//     ensureImageExistsWithRecovery() can heal the runtime and retry
//   - tolerate a concurrent create (startup's ensureImageReady racing it)
// ============================================================================

const execCommands: string[] = []

// Scripted outcomes for successive `image inspect` calls. Each entry is
// either 'ok' or an error message to reject with; calls beyond the script
// succeed. Reset per test.
let inspectScript: (string | 'ok')[] = []
let inspectAttempts = 0

// Whether the (fake) runtime is currently reachable — drives the test
// client's static isRunning() probe.
let runtimeReachable = true

// When true, handleRunError() "heals" the runtime (marks it reachable and
// makes subsequent inspects succeed) and reports recovery.
let healOnRunError = false
let handleRunErrorCalls = 0

vi.mock('child_process', () => {
  const exec = (
    command: string,
    optionsOrCb: unknown,
    maybeCb?: (err: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void
    execCommands.push(command)

    if (/image inspect/.test(command)) {
      const outcome = inspectScript[inspectAttempts] ?? 'ok'
      inspectAttempts++
      if (outcome !== 'ok') {
        cb(new Error(outcome))
        return {}
      }
      cb(null, { stdout: '[]', stderr: '' })
      return {}
    }

    if (/run\s+-d/.test(command)) {
      cb(null, { stdout: 'fake-container-id', stderr: '' })
      return {}
    }

    // ps → no used ports; stop/rm → succeed silently.
    cb(null, { stdout: '', stderr: '' })
    return {}
  }
  return {
    exec,
    execSync: vi.fn(),
    spawn: vi.fn(),
  }
})

vi.mock('net', () => {
  const createServer = vi.fn(() => {
    const listeners = new Map<string, () => void>()
    return {
      once: vi.fn((event: string, callback: () => void) => {
        listeners.set(event, callback)
      }),
      close: vi.fn(),
      listen: vi.fn(() => {
        queueMicrotask(() => listeners.get('listening')?.())
      }),
    }
  })

  return {
    default: { createServer },
    createServer,
  }
})

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

const pullImageMock = vi.fn((_runner: string, _image: string) => Promise.resolve())
const buildImageMock = vi.fn((_runner: string, _image: string) => Promise.resolve())
const checkImageExistsMock = vi.fn((_runner: string, _image: string) => Promise.resolve(false))
let canBuild = false
let availableDiskBytes = 100 * 1024 * 1024 * 1024
vi.mock('./client-factory', () => ({
  canBuildImage: vi.fn(() => canBuild),
  pullImage: (runner: string, image: string) => pullImageMock(runner, image),
  buildImage: (runner: string, image: string) => buildImageMock(runner, image),
  checkImageExists: (runner: string, image: string) => checkImageExistsMock(runner, image),
  getAvailableDiskSpace: vi.fn(() => Promise.resolve(availableDiskBytes)),
  MIN_IMAGE_DISK_SPACE_BYTES: 5 * 1024 * 1024 * 1024,
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({
    enableToolSearch: false,
    container: {
      agentImage: 'superagent/agent:test',
      containerRunner: 'docker',
      resourceLimits: { cpu: 2, memory: '2g' },
    },
  })),
}))

vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: vi.fn(() => ({
    getContainerEnvVars: () => ({}),
  })),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getAgentWorkspaceDir: vi.fn(() => '/tmp/ensure-image-workspace'),
}))

vi.mock('fs', () => {
  const noop = vi.fn()
  return {
    default: { mkdirSync: noop, writeFileSync: noop, unlinkSync: noop },
    mkdirSync: noop,
    writeFileSync: noop,
    unlinkSync: noop,
  }
})

import { BaseContainerClient } from './base-container-client'
import type { ContainerConfig, ContainerInfo } from './types'

// Failure shapes lifted from real Sentry events: the Lima nerdctl wrapper
// delegates over limactl/ssh, so a wedged VM fails ANY command with exit 255
// and empty stderr — indistinguishable from image-missing by exit code alone.
const WEDGED_VM_INSPECT_MSG =
  'Command failed: /Users/nick/.superagent/bin/lima-nerdctl image inspect superagent/agent:test'
const IMAGE_MISSING_INSPECT_MSG =
  'Command failed: docker image inspect superagent/agent:test\nError: No such image: superagent/agent:test'

class TestContainerClient extends BaseContainerClient {
  protected getRunnerCommand(): string {
    return 'docker'
  }
  static async isRunning(): Promise<boolean> {
    return runtimeReachable
  }
  protected async handleRunError(_error: any): Promise<boolean> {
    handleRunErrorCalls++
    if (healOnRunError) {
      runtimeReachable = true
      inspectScript = [] // healed → inspects succeed from now on
      return true
    }
    return false
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'stopped', port: null }
  }
  async waitForHealthy(): Promise<boolean> {
    return true
  }
}

const IMAGE = 'superagent/agent:test'

function makeClient(): TestContainerClient {
  return new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)
}

function buildExecAttempted(): boolean {
  return execCommands.some((c) => /\bbuild\b/.test(c))
}

describe('ensureImageExists via start()', () => {
  beforeEach(() => {
    execCommands.length = 0
    inspectScript = []
    inspectAttempts = 0
    runtimeReachable = true
    healOnRunError = false
    handleRunErrorCalls = 0
    canBuild = false
    availableDiskBytes = 100 * 1024 * 1024 * 1024
    pullImageMock.mockClear()
    pullImageMock.mockResolvedValue(undefined)
    buildImageMock.mockClear()
    checkImageExistsMock.mockClear()
    checkImageExistsMock.mockResolvedValue(false)
  })

  it('starts without creating anything when the image exists', async () => {
    await makeClient().start()

    expect(pullImageMock).not.toHaveBeenCalled()
    expect(buildImageMock).not.toHaveBeenCalled()
    expect(buildExecAttempted()).toBe(false)
  })

  it('pulls (never builds) when the image is missing and no build context exists (packaged app)', async () => {
    inspectScript = [IMAGE_MISSING_INSPECT_MSG]

    await makeClient().start()

    expect(pullImageMock).toHaveBeenCalledWith('docker', IMAGE)
    expect(buildImageMock).not.toHaveBeenCalled()
    // The old doomed fallback shelled out to `<runner> build` — must be gone.
    expect(buildExecAttempted()).toBe(false)
  })

  it('builds when the local agent-container context exists (dev)', async () => {
    canBuild = true
    inspectScript = [IMAGE_MISSING_INSPECT_MSG]

    await makeClient().start()

    expect(buildImageMock).toHaveBeenCalledWith('docker', IMAGE)
    expect(pullImageMock).not.toHaveBeenCalled()
  })

  it('does not attempt build/pull when the runtime is unreachable; heals and retries instead', async () => {
    // Wedged VM: every command fails until handleRunError() heals it.
    inspectScript = [WEDGED_VM_INSPECT_MSG, WEDGED_VM_INSPECT_MSG]
    runtimeReachable = false
    healOnRunError = true

    await makeClient().start()

    expect(handleRunErrorCalls).toBe(1)
    // The image was never missing — after healing, no create must happen.
    expect(pullImageMock).not.toHaveBeenCalled()
    expect(buildImageMock).not.toHaveBeenCalled()
    expect(buildExecAttempted()).toBe(false)
  })

  it('surfaces a runtime-unreachable error (not a build error) when healing fails', async () => {
    inspectScript = [WEDGED_VM_INSPECT_MSG, WEDGED_VM_INSPECT_MSG]
    runtimeReachable = false
    healOnRunError = false

    await expect(makeClient().start()).rejects.toThrow(/runtime unreachable/i)

    expect(pullImageMock).not.toHaveBeenCalled()
    expect(buildImageMock).not.toHaveBeenCalled()
    expect(buildExecAttempted()).toBe(false)
  })

  it('succeeds when a concurrent create produced the image despite our pull failing', async () => {
    inspectScript = [IMAGE_MISSING_INSPECT_MSG]
    pullImageMock.mockRejectedValueOnce(new Error('Image pull failed with exit code 1: connection reset'))
    checkImageExistsMock.mockResolvedValueOnce(true)

    await makeClient().start()

    expect(checkImageExistsMock).toHaveBeenCalledWith('docker', IMAGE)
  })

  it('propagates the pull error when the image is genuinely missing and the pull fails', async () => {
    // Both the initial attempt and the post-recovery retry fail the pull.
    inspectScript = [IMAGE_MISSING_INSPECT_MSG, IMAGE_MISSING_INSPECT_MSG]
    pullImageMock.mockRejectedValue(new Error('Image pull failed with exit code 1: no route to host'))

    await expect(makeClient().start()).rejects.toThrow(/Image pull failed/i)

    expect(buildImageMock).not.toHaveBeenCalled()
    expect(buildExecAttempted()).toBe(false)
  })

  it('refuses to create the image on a nearly-full disk instead of corrupting the store', async () => {
    inspectScript = [IMAGE_MISSING_INSPECT_MSG, IMAGE_MISSING_INSPECT_MSG]
    availableDiskBytes = 1 * 1024 * 1024 * 1024

    await expect(makeClient().start()).rejects.toThrow(/Insufficient disk space/i)

    expect(pullImageMock).not.toHaveBeenCalled()
    expect(buildImageMock).not.toHaveBeenCalled()
  })

  it('tags create failures so runner heuristics never mistake registry errors for VM issues', async () => {
    inspectScript = [IMAGE_MISSING_INSPECT_MSG, IMAGE_MISSING_INSPECT_MSG]
    // Canonical registry-404 text: contains "not found", which Lima/WSL2
    // handleRunError would otherwise string-match as a VM issue.
    pullImageMock.mockRejectedValue(new Error('Image pull failed with exit code 1: ghcr.io/x/y:9.9.9: not found'))

    let caught: unknown
    await makeClient().start().catch((e) => { caught = e })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { isImageCreateError?: boolean }).isImageCreateError).toBe(true)
  })

  it('retries the pull once after the runtime self-heals mid-pull', async () => {
    // First pass: image missing on a reachable runtime, but the pull fails
    // (e.g. containerd hiccup). handleRunError() heals; the retry's inspect
    // still misses so the pull runs again and succeeds.
    inspectScript = [IMAGE_MISSING_INSPECT_MSG, IMAGE_MISSING_INSPECT_MSG]
    healOnRunError = true
    pullImageMock.mockRejectedValueOnce(new Error('Image pull failed with exit code 255'))

    const client = makeClient()
    // Healing resets inspectScript to [] which would make the retry's inspect
    // succeed — keep the image missing so the retry exercises the pull.
    const origHandle = (client as any).handleRunError.bind(client)
    ;(client as any).handleRunError = async (err: any) => {
      const result = await origHandle(err)
      inspectScript = [IMAGE_MISSING_INSPECT_MSG]
      inspectAttempts = 0
      return result
    }

    await client.start()

    expect(pullImageMock).toHaveBeenCalledTimes(2)
  })
})
