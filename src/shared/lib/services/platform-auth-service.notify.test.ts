/**
 * Fire-and-forget notify coverage on the real modules.
 *
 * platform-auth-service dynamically imports platform-service on auth changes
 * (cycle-breaking import that no caller awaits). Nothing else exercises that
 * import end-to-end, so this suite drives it through the public disconnect
 * path and asserts the success signal.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tempDataDir: string
let prevDataDir: string | undefined

beforeAll(async () => {
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'platform-notify-'))
  process.env.SUPERAGENT_DATA_DIR = tempDataDir
})

afterAll(async () => {
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

describe('platform-service auth-change notify (unmocked)', () => {
  it('completes the fire-and-forget platform-service import on disconnect', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const { revokePlatformToken } = await import('./platform-auth-service')

    // No stored token in the temp data dir: the remote revoke short-circuits
    // (no network), but the local clear still fires the notify path.
    const revoked = await revokePlatformToken()
    expect(revoked).toBe(false)

    await vi.waitFor(
      () => {
        const notified = logSpy.mock.calls.some((c) =>
          String(c[0]).includes('platform-service notified of auth change (connected=false)')
        )
        expect(notified).toBe(true)
      },
      { timeout: 10000, interval: 50 }
    )

    logSpy.mockRestore()
  })
})
