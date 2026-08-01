import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real filesystem in a temp data dir — the module under test is pure fs
// manipulation, so mocking fs would just re-state the implementation.
const h = vi.hoisted(() => ({ dataDir: '' }))

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => h.dataDir,
}))

const captureMessage = vi.fn()
const captureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  captureException: (...args: unknown[]) => captureException(...args),
}))

import {
  cleanupBrowserProfiles,
  deleteBrowserProfile,
  markProfileInUse,
  unmarkProfileInUse,
  startBrowserProfileCleanup,
  stopBrowserProfileCleanup,
  waitForBrowserProfileCleanup,
} from './profile-maintenance'

const PROFILES = 'host-browser-profiles'
const LEGACY = 'host-browser-profile'

function makeProfile(agentId: string, extras: string[] = []) {
  const dir = path.join(h.dataDir, PROFILES, agentId)
  // Session state that must survive every sweep.
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'cookies')
  for (const extra of extras) {
    fs.mkdirSync(path.join(dir, extra), { recursive: true })
    fs.writeFileSync(path.join(dir, extra, 'blob.bin'), 'x'.repeat(1024))
  }
  return dir
}

describe('browser profile maintenance', () => {
  beforeEach(() => {
    h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-browser-profiles-'))
    captureMessage.mockClear()
    captureException.mockClear()
  })

  afterEach(() => {
    fs.rmSync(h.dataDir, { recursive: true, force: true })
  })

  it('removes the legacy singular host-browser-profile directory', async () => {
    const legacyDir = path.join(h.dataDir, LEGACY)
    fs.mkdirSync(path.join(legacyDir, 'Default'), { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'Local State'), '{}')

    await cleanupBrowserProfiles([])

    expect(fs.existsSync(legacyDir)).toBe(false)
  })

  it('removes orphaned profile dirs and keeps profiles of existing agents', async () => {
    const kept = makeProfile('agent-alive')
    const orphaned = makeProfile('agent-deleted')

    await cleanupBrowserProfiles(['agent-alive'])

    expect(fs.existsSync(kept)).toBe(true)
    expect(fs.existsSync(orphaned)).toBe(false)
  })

  it('strips regenerable caches but preserves Default session state', async () => {
    const dir = makeProfile('agent1', [
      'OptGuideOnDeviceModel/2025.8.8.1141',
      'optimization_guide_model_store',
      'component_crx_cache',
      'WasmTtsEngine',
      'Safe Browsing',
      'GrShaderCache',
      path.join('Default', 'Cache'),
      path.join('Default', 'Code Cache'),
      path.join('Default', 'GPUCache'),
    ])
    fs.writeFileSync(path.join(dir, 'Default', 'Login Data'), 'logins')
    fs.mkdirSync(path.join(dir, 'Default', 'Local Storage'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Default', 'Local Storage', 'data'), 'ls')

    await cleanupBrowserProfiles(['agent1'])

    // Regenerable caches are gone…
    expect(fs.existsSync(path.join(dir, 'OptGuideOnDeviceModel'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'optimization_guide_model_store'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'component_crx_cache'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'WasmTtsEngine'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'Safe Browsing'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'Default', 'Cache'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'Default', 'Code Cache'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'Default', 'GPUCache'))).toBe(false)
    // …while session state survives.
    expect(fs.readFileSync(path.join(dir, 'Default', 'Cookies'), 'utf-8')).toBe('cookies')
    expect(fs.readFileSync(path.join(dir, 'Default', 'Login Data'), 'utf-8')).toBe('logins')
    expect(fs.existsSync(path.join(dir, 'Default', 'Local Storage', 'data'))).toBe(true)
  })

  it('leaves profiles marked in-use completely alone until unmarked', async () => {
    const busy = makeProfile('agent-busy', ['component_crx_cache'])
    const idle = makeProfile('agent-idle', ['component_crx_cache'])

    markProfileInUse('agent-busy')
    try {
      await cleanupBrowserProfiles(['agent-idle'])
    } finally {
      unmarkProfileInUse('agent-busy')
    }

    // agent-busy is not in the agent list (would be orphan-deleted) AND has
    // strippable caches — the in-use mark must win over both.
    expect(fs.existsSync(path.join(busy, 'component_crx_cache'))).toBe(true)
    expect(fs.existsSync(path.join(idle, 'component_crx_cache'))).toBe(false)

    // After unmarking, the next sweep reclaims it.
    await cleanupBrowserProfiles(['agent-idle'])
    expect(fs.existsSync(busy)).toBe(false)
  })

  it('is a no-op when the profiles directory does not exist', async () => {
    await expect(cleanupBrowserProfiles(['agent1'])).resolves.toBeUndefined()
    expect(captureException).not.toHaveBeenCalled()
  })

  it('reports when the swept directory still exceeds the size budget', async () => {
    const dir = makeProfile('agent1')
    // A sparse file whose stat size exceeds the 2 GiB threshold without
    // actually consuming disk.
    const bigFile = path.join(dir, 'Default', 'huge.bin')
    fs.writeFileSync(bigFile, '')
    fs.truncateSync(bigFile, 3 * 1024 * 1024 * 1024)

    await cleanupBrowserProfiles(['agent1'])

    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(String(captureMessage.mock.calls[0][0])).toMatch(/size budget/i)
  })

  it('does not report when the directory is within budget', async () => {
    makeProfile('agent1')
    await cleanupBrowserProfiles(['agent1'])
    expect(captureMessage).not.toHaveBeenCalled()
  })

  describe('deleteBrowserProfile', () => {
    it('removes the profile dir for the agent', async () => {
      const dir = makeProfile('agent1')
      await deleteBrowserProfile('agent1')
      expect(fs.existsSync(dir)).toBe(false)
    })

    it('resolves when the profile dir never existed', async () => {
      await expect(deleteBrowserProfile('never-launched')).resolves.toBeUndefined()
    })

    it('refuses ids that escape the profiles root', async () => {
      const outside = path.join(h.dataDir, 'victim')
      fs.mkdirSync(outside)
      await expect(deleteBrowserProfile('../victim')).rejects.toThrow(/outside profiles root/)
      expect(fs.existsSync(outside)).toBe(true)
    })

    it('refuses ids that resolve to the profiles root itself', async () => {
      const kept = makeProfile('agent1')
      await expect(deleteBrowserProfile('')).rejects.toThrow(/outside profiles root/)
      await expect(deleteBrowserProfile('.')).rejects.toThrow(/outside profiles root/)
      expect(fs.existsSync(kept)).toBe(true)
    })
  })

  describe('startBrowserProfileCleanup', () => {
    afterEach(() => {
      stopBrowserProfileCleanup()
    })

    it('runs the sweep after the configured delay and exposes it to waitForBrowserProfileCleanup', async () => {
      const orphaned = makeProfile('agent-deleted')
      startBrowserProfileCleanup(() => ['agent-alive'], { delayMs: 0 })
      // waitForBrowserProfileCleanup resolves immediately until the timer
      // fires (launches proceed pre-sweep by design), so wait for the effect.
      await vi.waitFor(() => expect(fs.existsSync(orphaned)).toBe(false))
      await waitForBrowserProfileCleanup()
    })

    it('resolves the agent list when the timer fires, not when scheduled', async () => {
      // An agent created AFTER scheduling but before the sweep fires must not
      // be classified as an orphan — that would delete its cookies/session.
      const agents = ['agent-old']
      makeProfile('agent-old')
      startBrowserProfileCleanup(async () => [...agents], { delayMs: 30 })

      agents.push('agent-created-during-delay')
      const created = makeProfile('agent-created-during-delay')
      const orphaned = makeProfile('agent-deleted')

      await vi.waitFor(() => expect(fs.existsSync(orphaned)).toBe(false))
      await waitForBrowserProfileCleanup()
      expect(fs.existsSync(path.join(created, 'Default', 'Cookies'))).toBe(true)
    })

    it('does not sweep before the delay elapses, and stop cancels a pending sweep', async () => {
      const orphaned = makeProfile('agent-deleted')
      startBrowserProfileCleanup(() => ['agent-alive'], { delayMs: 60_000 })
      stopBrowserProfileCleanup()
      await new Promise((r) => setTimeout(r, 25))
      expect(fs.existsSync(orphaned)).toBe(true)
    })

    it('captures sweep failures instead of rejecting', async () => {
      // Point the data dir at a path whose parent is a FILE so readdir fails
      // with ENOTDIR (not the tolerated ENOENT).
      const file = path.join(h.dataDir, 'not-a-dir')
      fs.writeFileSync(file, '')
      h.dataDir = file

      startBrowserProfileCleanup(() => ['agent1'], { delayMs: 0 })
      await vi.waitFor(() => expect(captureException).toHaveBeenCalledTimes(1))
      await waitForBrowserProfileCleanup()
    })

    it('captures a failing agent-list supplier instead of rejecting', async () => {
      const orphaned = makeProfile('agent-deleted')
      startBrowserProfileCleanup(
        async () => { throw new Error('agent listing failed') },
        { delayMs: 0 },
      )
      await vi.waitFor(() => expect(captureException).toHaveBeenCalledTimes(1))
      await waitForBrowserProfileCleanup()
      // A failed listing must never be treated as "no agents exist".
      expect(fs.existsSync(orphaned)).toBe(true)
    })
  })
})
