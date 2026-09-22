import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Corrupt-image-content recovery in start().
//
// The snapshot case (corrupt-image-snapshot-recovery.test.ts) is a `run` that
// fails to mount. This is the other shape of the same corruption: `run`
// succeeds, the agent server boots, and Node dies reading a file that ships
// inside the image — a truncated /app/node_modules/<pkg>/package.json
// ("Invalid package config", ERR_INVALID_PACKAGE_CONFIG), a module missing
// from /app/dist, a JS file cut off mid-way. The container never becomes
// healthy and retrying against the same image can never succeed, so start()
// must remove the image, recreate it, and try once more.
//
// These tests record every command handed to child_process.exec and script
// the health-check outcome and the container logs per attempt.
// ============================================================================

const execCommands: string[] = []

// Scripted health outcomes for successive run attempts; attempts beyond the
// script are healthy.
let healthScript: boolean[] = []
let healthAttempts = 0

// Container logs returned when a health check fails.
let containerLogs = ''

// Lifted from a real Sentry event (Docker Desktop on Windows, app 0.5.19):
// the image's unpacked copy of hono/package.json was garbled on disk.
const INVALID_PACKAGE_CONFIG_LOGS = `node:internal/modules/package_json_reader:116
  const parsed = modulesBinding.readPackageJSON(
                                ^

Error: Invalid package config /app/node_modules/hono/package.json.
    at Object.read (node:internal/modules/package_json_reader:116:33)
    at _readPackage (node:internal/modules/cjs/loader:482:55)
    at Module.require (node:internal/modules/cjs/loader:1527:12) {
  code: 'ERR_INVALID_PACKAGE_CONFIG'
}

Node.js v22.23.2`

const MISSING_DIST_MODULE_LOGS = `node:internal/modules/cjs/loader:1228
  throw err;
  ^

Error: Cannot find module '/app/dist/session-manager.js'
Require stack:
- /app/dist/index.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15) {
  code: 'MODULE_NOT_FOUND'
}`

const TRUNCATED_JS_LOGS = `/app/node_modules/@hono/node-server/dist/index.js:412
    for (const [k, v] of Object.entries(headers)) {
                                                   

SyntaxError: Unexpected end of input
    at wrapSafe (node:internal/modules/cjs/loader:1378:20)`

// A workspace file the agent itself wrote: user data, not image content.
const WORKSPACE_PACKAGE_LOGS = `Error: Invalid package config /workspace/project/package.json.
    at Object.read (node:internal/modules/package_json_reader:116:33) {
  code: 'ERR_INVALID_PACKAGE_CONFIG'
}`

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
    if (/run\s+-d/.test(command)) {
      cb(null, { stdout: 'fake-container-id', stderr: '' })
      return {}
    }
    // image inspect → found; ps → no used ports; rmi/stop/rm → succeed silently.
    cb(null, { stdout: '', stderr: '' })
    return {}
  }
  return { exec, execSync: vi.fn(), spawn: vi.fn() }
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
  return { default: { createServer }, createServer }
})

const captureExceptionMock = vi.fn()
const captureMessageMock = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
  addErrorBreadcrumb: vi.fn(),
}))

const pullImageMock = vi.fn((_runner: string, _image: string) => Promise.resolve())
const buildImageMock = vi.fn((_runner: string, _image: string) => Promise.resolve())
let canBuild = false
vi.mock('./client-factory', () => ({
  canBuildImage: vi.fn(() => canBuild),
  pullImage: (runner: string, image: string) => pullImageMock(runner, image),
  buildImage: (runner: string, image: string) => buildImageMock(runner, image),
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
  getAgentWorkspaceDir: vi.fn(() => '/tmp/corrupt-content-workspace'),
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
 * Reports the container as stopped so start() runs the full path, and plays
 * back the scripted health outcomes and logs instead of polling a socket.
 */
class TestContainerClient extends BaseContainerClient {
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'stopped', port: null }
  }
  async waitForHealthy(): Promise<boolean> {
    const outcome = healthScript[healthAttempts] ?? true
    healthAttempts++
    return outcome
  }
  async getLogs(): Promise<string> {
    return containerLogs
  }
}

const IMAGE = 'superagent/agent:test'
const CONTAINER = 'superagent-abc123'

function countRunAttempts(): number {
  return execCommands.filter((c) => /run\s+-d/.test(c)).length
}

function rmiCommands(): string[] {
  return execCommands.filter((c) => c.includes(`rmi -f ${IMAGE}`))
}

function makeClient(): TestContainerClient {
  return new TestContainerClient({ agentId: 'abc123' } as ContainerConfig)
}

describe('start() recovers from corrupt image content', () => {
  beforeEach(() => {
    execCommands.length = 0
    healthScript = []
    healthAttempts = 0
    containerLogs = ''
    canBuild = false
    pullImageMock.mockClear()
    pullImageMock.mockResolvedValue(undefined)
    buildImageMock.mockClear()
    captureExceptionMock.mockClear()
    captureMessageMock.mockClear()
  })

  it('removes the image, re-pulls it, and starts again when the server dies on an invalid package.json', async () => {
    healthScript = [false, true]
    containerLogs = INVALID_PACKAGE_CONFIG_LOGS

    const info = await makeClient().start()

    expect(info).toEqual({ status: 'running', port: 4000 })
    expect(rmiCommands()).toHaveLength(1)
    expect(pullImageMock).toHaveBeenCalledWith('docker', IMAGE)
    expect(buildImageMock).not.toHaveBeenCalled()
    expect(countRunAttempts()).toBe(2)
    // The recovery is reported as a warning, not as a health-check error.
    expect(captureMessageMock).toHaveBeenCalledWith(
      'Recovered from corrupt container image content',
      expect.objectContaining({ level: 'warning' })
    )
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('removes the dead container before the image so rmi is not refused', async () => {
    healthScript = [false, true]
    containerLogs = INVALID_PACKAGE_CONFIG_LOGS

    await makeClient().start()

    const rmiIndex = execCommands.findIndex((c) => c.includes(`rmi -f ${IMAGE}`))
    const firstRunIndex = execCommands.findIndex((c) => /run\s+-d/.test(c))
    const rmBetween = execCommands
      .slice(firstRunIndex, rmiIndex)
      .filter((c) => c === `docker rm -f ${CONTAINER}`)
    expect(rmBetween).toHaveLength(1)
  })

  it('rebuilds instead of pulling when a local build context exists (dev)', async () => {
    canBuild = true
    healthScript = [false, true]
    containerLogs = INVALID_PACKAGE_CONFIG_LOGS

    await makeClient().start()

    expect(buildImageMock).toHaveBeenCalledWith('docker', IMAGE)
    expect(pullImageMock).not.toHaveBeenCalled()
    expect(countRunAttempts()).toBe(2)
  })

  it.each([
    ['a module missing from /app/dist', MISSING_DIST_MODULE_LOGS],
    ['a JS file truncated mid-way', TRUNCATED_JS_LOGS],
  ])('recognises %s as corrupt image content', async (_label, logs) => {
    healthScript = [false, true]
    containerLogs = logs

    await makeClient().start()

    expect(rmiCommands()).toHaveLength(1)
    expect(countRunAttempts()).toBe(2)
  })

  it('gives up after one recovery attempt when the corruption persists', async () => {
    healthScript = [false, false]
    containerLogs = INVALID_PACKAGE_CONFIG_LOGS

    await expect(makeClient().start()).rejects.toThrow(/Container failed to become healthy/)

    // One recovery, two run attempts total — never loops.
    expect(rmiCommands()).toHaveLength(1)
    expect(countRunAttempts()).toBe(2)
    // The dead container from the second attempt is still cleaned up.
    expect(execCommands.filter((c) => c === `docker stop ${CONTAINER}`)).toHaveLength(1)
  })

  it('surfaces the health error (with logs) when the re-pull itself fails', async () => {
    pullImageMock.mockRejectedValueOnce(new Error('Image pull failed with exit code 1'))
    healthScript = [false]
    containerLogs = INVALID_PACKAGE_CONFIG_LOGS

    await expect(makeClient().start()).rejects.toThrow(/Invalid package config \/app\/node_modules\/hono/)

    expect(countRunAttempts()).toBe(1)
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ operation: 'corrupt-image-recovery' }) })
    )
  })

  it('does not remove the image when the health check fails for other reasons', async () => {
    healthScript = [false]
    containerLogs = 'Listening on :4000\nWarning: slow disk'

    await expect(makeClient().start()).rejects.toThrow(/Container failed to become healthy/)

    expect(rmiCommands()).toHaveLength(0)
    expect(pullImageMock).not.toHaveBeenCalled()
    expect(countRunAttempts()).toBe(1)
  })

  it('does not remove the image for an invalid package.json under /workspace (user data)', async () => {
    healthScript = [false]
    containerLogs = WORKSPACE_PACKAGE_LOGS

    await expect(makeClient().start()).rejects.toThrow(/Container failed to become healthy/)

    expect(rmiCommands()).toHaveLength(0)
    expect(countRunAttempts()).toBe(1)
  })

  it('does not remove the image when the health check fails with no logs at all', async () => {
    healthScript = [false]
    containerLogs = ''

    await expect(makeClient().start()).rejects.toThrow(/Container failed to become healthy/)

    expect(rmiCommands()).toHaveLength(0)
    expect(countRunAttempts()).toBe(1)
  })
})
