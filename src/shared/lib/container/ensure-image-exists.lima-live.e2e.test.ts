import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

// ============================================================================
// Live validation of ensureImageExists() against the REAL bundled Lima VM.
// Gated by RUN_LIMA_IMAGE_E2E=1 so it never runs in CI:
//
//   RUN_LIMA_IMAGE_E2E=1 npx vitest run \
//     src/shared/lib/container/ensure-image-exists.lima-live.e2e.test.ts
//
// Requirements: the bundled Lima VM ("superagent" instance under
// ~/.superagent/lima) exists, and either the packaged app's bundled limactl
// is present (/Applications/Gamut.app) or limactl is on PATH.
//
// WARNING: the wedged-VM test STOPS the shared Lima VM (killing any agent
// containers inside it) and asserts the fix restarts it. Only run on a
// machine where that is acceptable. A running production app may race the
// heal by restarting the VM itself; the assertions hold either way.
// ============================================================================

const enabled = process.env.RUN_LIMA_IMAGE_E2E === '1'

// Keep Sentry quiet — these paths capture on failure.
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  getActiveLlmProvider: () => ({ getContainerEnvVars: () => ({}) }),
}))

// Real Lima runner, tiny throwaway image for the pull test. The mock is
// mutable so each test picks its image.
const settingsState = {
  agentImage: 'docker.io/library/alpine:3.20',
}
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({
    enableToolSearch: false,
    container: {
      containerRunner: 'lima',
      agentImage: settingsState.agentImage,
      resourceLimits: { cpu: 2, memory: '2g' },
      // No runtimeSettings.lima.vmMemory: an explicit value that differs from
      // the live VM would make ensureLimaReady() RECREATE (wipe) it.
    },
  }),
}))

import { LimaContainerClient, getLimaHome, getLimactlPath, getNerdctlWrapperPath } from './lima-container-client'
import type { ContainerConfig } from './types'

class LiveClient extends LimaContainerClient {
  ensureImage(): Promise<void> {
    return this.ensureImageExistsWithRecovery()
  }
}

const ALPINE = 'docker.io/library/alpine:3.20'
const VM_NAME = 'superagent'

function limactl(args: string[]): string {
  return execFileSync(getLimactlPath(), args, {
    env: { ...process.env, LIMA_HOME: getLimaHome() },
    encoding: 'utf-8',
    timeout: 180_000,
  })
}

function nerdctl(args: string[]): string {
  return execFileSync(getNerdctlWrapperPath(), args, { encoding: 'utf-8', timeout: 120_000 })
}

function vmStatus(): string {
  const line = limactl(['list', '--json']).trim().split('\n').find((l) => l.includes(`"${VM_NAME}"`))
  return line ? JSON.parse(line).status : 'Missing'
}

describe.skipIf(!enabled)('ensureImageExists against the live Lima VM', () => {
  const originalCwd = process.cwd()
  const originalResourcesPath = process.resourcesPath
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    // Impersonate the packaged app: bundled limactl via process.resourcesPath...
    const gamutResources = '/Applications/Gamut.app/Contents/Resources'
    if (fs.existsSync(path.join(gamutResources, 'lima', 'bin', 'limactl'))) {
      ;(process as any).resourcesPath = gamutResources
    }
    // ...and no local build context in cwd, so canBuildImage() is false and
    // the missing-image path must PULL (the packaged-app decision under test).
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-image-live-'))
    process.chdir(scratch)
    expect(fs.existsSync('./agent-container')).toBe(false)

    logSpy = vi.spyOn(console, 'log')
  })

  afterAll(() => {
    process.chdir(originalCwd)
    ;(process as any).resourcesPath = originalResourcesPath
    // Leave the VM as we found it: running, without the throwaway image.
    try { nerdctl(['rmi', '-f', ALPINE]) } catch { /* not present */ }
  })

  it('pulls (never builds) when the image is missing — ELECTRON-4T/5B path', async () => {
    settingsState.agentImage = ALPINE
    try { nerdctl(['rmi', '-f', ALPINE]) } catch { /* not present */ }
    logSpy.mockClear()

    const client = new LiveClient({ agentId: 'live-e2e' } as ContainerConfig)
    await client.ensureImage()

    // The image is now really in the VM's containerd store.
    expect(nerdctl(['images', '--format', '{{.Repository}}:{{.Tag}}'])).toContain('alpine')
    const logs = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(logs).toContain(`Pulling container image ${ALPINE}`)
    expect(logs).not.toContain('Building container image')
  }, 300_000)

  it('heals a stopped VM and retries instead of build/pull — ELECTRON-4S path', async () => {
    // Use an image already present in the VM so a correct run needs NO create.
    const existing = nerdctl(['images', '--format', '{{.Repository}}:{{.Tag}}'])
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('<none>'))[0]
    expect(existing).toBeTruthy()
    settingsState.agentImage = existing

    limactl(['stop', VM_NAME])
    expect(vmStatus()).toBe('Stopped')
    logSpy.mockClear()

    const client = new LiveClient({ agentId: 'live-e2e' } as ContainerConfig)
    await client.ensureImage()

    // The fix healed the runtime (limactl start) and found the image on retry.
    expect(vmStatus()).toBe('Running')
    const logs = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(logs).toContain(`Container image ${existing} found`)
    expect(logs).not.toContain('Building container image')
    // No pull either — the image was never missing. (Tolerated if a racing
    // production app healed the VM before our probe ran; the log assertion
    // above still guarantees the inspect retry succeeded.)
    expect(logs).not.toContain(`Pulling container image ${existing}`)
  }, 300_000)
})
