import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// SUP-212 — An unhealthy container start must not leave the failed container
// running. In start(), when waitForHealthy() returns false the code grabs
// logs, reports to Sentry and throws — but (pre-fix) never stops/removes the
// container it just created. A leftover process-alive-but-unhealthy container
// then short-circuits the next start() via the running-status early return,
// caching it as 'running' even though /health never passed.
//
// This test records every command the runtime runner is asked to execute and
// asserts that, after the failed health check, a `stop`/`rm superagent-<id>`
// is issued AFTER the `run -d ... --name superagent-<id>` command.
// ============================================================================

// Record every command string handed to child_process.exec (which
// base-container-client promisifies into execAsync at module load).
const execCommands: string[] = []

vi.mock('child_process', () => {
  // promisify(exec) calls exec(command, options, callback) and resolves with
  // whatever the callback's second arg is. We resolve every command with an
  // { stdout, stderr } object so `const { stdout } = await execAsync(...)`
  // works, pattern-matching the few commands start() actually cares about.
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

    let stdout = ''
    if (/run\s+-d/.test(command)) stdout = 'fake-container-id'
    // image inspect → image found (skip build); ps → no used ports; logs → empty.
    // stop/rm/everything else → resolve empty. Nothing rejects: the runner
    // succeeds, only the health check fails.
    cb(null, { stdout, stderr: '' })
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
  getAgentWorkspaceDir: vi.fn(() => '/tmp/sup212-workspace'),
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
 * Concrete subclass whose health check always fails immediately (no 60s real
 * wait), and which reports the container as stopped at the start() early-return
 * guard so we proceed into the run+health path instead of short-circuiting.
 */
class TestContainerClient extends BaseContainerClient {
  protected getRunnerCommand(): string {
    return 'docker'
  }
  // Report stopped at the line 504 early-return so start() runs the full path.
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'stopped', port: null }
  }
  // Fail fast so we don't sit in waitForHealthy's 60s loop.
  async waitForHealthy(): Promise<boolean> {
    return false
  }
}

describe('SUP-212 start() cleans up an unhealthy container', () => {
  beforeEach(() => {
    execCommands.length = 0
  })

  it('removes the just-created container after the health check fails', async () => {
    const client = new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)
    // No 'error' listener — start() emits 'error'; safeEmitError no-ops without one.

    await expect(client.start()).rejects.toThrow(/failed to become healthy/i)

    const containerName = 'superagent-abc123'
    const runIndex = execCommands.findIndex(
      (c) => /run\s+-d/.test(c) && c.includes(`--name ${containerName}`)
    )
    expect(runIndex).toBeGreaterThanOrEqual(0)

    // The fix issues a best-effort stop + rm AFTER the run command. Pre-fix,
    // the only stop/rm are the pre-run cleanup (before runIndex), so these fail.
    const stopAfterRun = execCommands
      .slice(runIndex + 1)
      .some((c) => c.includes(`stop ${containerName}`))
    const rmAfterRun = execCommands
      .slice(runIndex + 1)
      .some((c) => c.includes(`rm ${containerName}`))

    expect(rmAfterRun).toBe(true)
    expect(stopAfterRun).toBe(true)
  })

  it('still surfaces the health-check error to the caller', async () => {
    const client = new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)
    await expect(client.start()).rejects.toThrow(/failed to become healthy/i)
  })
})
