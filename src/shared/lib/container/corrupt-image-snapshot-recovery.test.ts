import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Corrupt-image-snapshot recovery in start().
//
// When `run` fails with containerd's "mount callback failed on
// /tmp/containerd-mountNNN: ..." (e.g. ": no users found" resolving the
// Dockerfile USER against a truncated /etc/passwd), the image's unpacked
// snapshot in the runtime store is corrupt. Retrying the identical run can
// never succeed, so start() must remove the image, recreate it, and retry —
// exactly once, so a rebuild that reproduces the corruption still terminates.
//
// These tests record every command handed to child_process.exec and script
// the `run -d` outcomes per attempt.
// ============================================================================

const execCommands: string[] = []

// Scripted outcomes for successive `run -d` attempts. Each entry is either
// 'ok' or an error message to reject with; attempts beyond the script succeed.
let runScript: (string | 'ok')[] = []
let runAttempts = 0

const CORRUPT_SNAPSHOT_MSG =
  'Command failed: /Users/nick/.superagent/bin/lima-nerdctl run -d --name superagent-abc123 ' +
  'time="2026-07-13T11:33:27-07:00" level=fatal msg="mount callback failed on /tmp/containerd-mount3006401431: no users found"'

vi.mock('child_process', () => {
  // promisify(exec) calls exec(command, options, callback) and resolves with
  // the callback's second arg, so every command resolves with { stdout, stderr }
  // unless the run script says this attempt fails.
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

    if (/run\s+-d/.test(command)) {
      const outcome = runScript[runAttempts] ?? 'ok'
      runAttempts++
      if (outcome !== 'ok') {
        cb(new Error(outcome))
        return {}
      }
      cb(null, { stdout: 'fake-container-id', stderr: '' })
      return {}
    }

    // image inspect → found (skip build); ps → no used ports; rmi/prune/stop/rm
    // → succeed silently.
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
  getAgentWorkspaceDir: vi.fn(() => '/tmp/corrupt-snapshot-workspace'),
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

/**
 * Concrete subclass that reports the container as stopped (so start() runs the
 * full run path instead of short-circuiting) and passes the health check
 * immediately (so a successful retry resolves without the 60s wait).
 */
class TestContainerClient extends BaseContainerClient {
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'stopped', port: null }
  }
  async waitForHealthy(): Promise<boolean> {
    return true
  }
}

const IMAGE = 'superagent/agent:test'

function countRunAttempts(): number {
  return execCommands.filter((c) => /run\s+-d/.test(c)).length
}

describe('start() recovers from a corrupt image snapshot', () => {
  beforeEach(() => {
    execCommands.length = 0
    runScript = []
    runAttempts = 0
  })

  it('removes the image, recreates it, and retries the run once', async () => {
    runScript = [CORRUPT_SNAPSHOT_MSG, 'ok']
    const client = new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)

    await client.start()

    const rmiIndex = execCommands.findIndex((c) => c.includes(`rmi -f ${IMAGE}`))
    expect(rmiIndex).toBeGreaterThanOrEqual(0)

    // ensureImageExists() runs again after the removal (image inspect follows
    // the rmi), so a rebuilt/re-pulled image backs the retry.
    const inspectAfterRmi = execCommands
      .slice(rmiIndex + 1)
      .some((c) => c.includes(`image inspect ${IMAGE}`))
    expect(inspectAfterRmi).toBe(true)

    expect(countRunAttempts()).toBe(2)
  })

  it('gives up after one recovery attempt when the corruption persists', async () => {
    runScript = [CORRUPT_SNAPSHOT_MSG, CORRUPT_SNAPSHOT_MSG]
    const client = new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)

    await expect(client.start()).rejects.toThrow(/mount callback failed/i)

    // One recovery, two run attempts total — never loops.
    expect(execCommands.filter((c) => c.includes(`rmi -f ${IMAGE}`))).toHaveLength(1)
    expect(countRunAttempts()).toBe(2)
  })

  it('does not remove the image for unrelated run failures', async () => {
    runScript = ['Command failed: docker run -d ... some unrelated failure']
    const client = new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)

    await expect(client.start()).rejects.toThrow(/unrelated failure/i)

    expect(execCommands.some((c) => c.includes('rmi'))).toBe(false)
    expect(countRunAttempts()).toBe(1)
  })
})
