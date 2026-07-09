/**
 * Boot-signal coverage: every background service launched by
 * initializeServices() must emit a positive "started" marker.
 *
 * startup.ts launches services with `.start().catch(console.error)`, so a
 * service that silently never finishes produces no signal — only failures
 * log. This suite boots the real startup path (real db, temp data dir,
 * E2E_MOCK container client) and asserts each service's success marker
 * fired and that no start failed. A new service added to startup.ts without
 * a start marker fails this test by design — extend EXPECTED_MARKERS.
 *
 * TriggerManager is asserted NOT to start here: startup gates it on a
 * platform access token, which this environment (correctly) lacks. Its
 * completion marker is exercised by nothing yet — testing it end-to-end
 * needs a platform-proxy mock harness.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const EXPECTED_MARKERS = [
  '[ContainerManager] Starting status sync',
  '[ContainerManager] Starting health monitor',
  '[TaskScheduler] Scheduler started',
  '[ChatIntegrationManager] Started',
  '[AutoSleepMonitor] Monitor started',
  '[SessionAutoDeleteMonitor] Monitor started',
  '[AccountSync] Service started',
  '[PlatformService] Started',
]

let tempDataDir: string
let prevDataDir: string | undefined
let prevE2eMock: string | undefined

beforeAll(async () => {
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  prevE2eMock = process.env.E2E_MOCK
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'boot-signals-'))
  process.env.SUPERAGENT_DATA_DIR = tempDataDir
  // Mock container client + muted analytics, same as the E2E harness.
  process.env.E2E_MOCK = 'true'
})

afterAll(async () => {
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  if (prevE2eMock === undefined) delete process.env.E2E_MOCK
  else process.env.E2E_MOCK = prevE2eMock
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

describe('initializeServices boot signals', () => {
  it('every background service emits its started marker and none fail', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const errorSpy = vi.spyOn(console, 'error')
    // Import after env setup so the db singleton binds to the temp dir.
    const { initializeServices, shutdownServices } = await import('./startup')

    try {
      await initializeServices()

      const logged = () => logSpy.mock.calls.map((c) => String(c[0]))

      // start() calls are fire-and-forget, so late markers can trail
      // initializeServices() itself — wait for the full set.
      await vi.waitFor(
        () => {
          const lines = logged()
          for (const marker of EXPECTED_MARKERS) {
            expect(lines.some((l) => l.includes(marker)), `missing marker: ${marker}`).toBe(true)
          }
        },
        { timeout: 15000, interval: 100 }
      )

      const failed = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('Failed to start'))
      expect(failed).toEqual([])

      // No platform token in this environment: the TriggerManager gate must
      // hold (a start here would mean the token gate regressed).
      expect(logged().some((l) => l.includes('[TriggerManager] Started'))).toBe(false)
    } finally {
      await shutdownServices()
      logSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})
