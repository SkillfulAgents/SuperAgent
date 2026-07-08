/**
 * Positive-start coverage for ChatIntegrationManager.start().
 *
 * startup.ts fires every background service with `.start().catch(console.error)`,
 * so a service that silently never finishes starting produces no signal at all —
 * only failures log. This suite asserts the success log line (which boot smoke
 * and humans reading prod logs rely on) using the real manager and real db
 * against a temp data dir.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tempDataDir: string
let prevDataDir: string | undefined

beforeAll(async () => {
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cim-start-'))
  process.env.SUPERAGENT_DATA_DIR = tempDataDir
})

afterAll(async () => {
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

describe('ChatIntegrationManager.start()', () => {
  it('logs a positive start signal once running', async () => {
    const logSpy = vi.spyOn(console, 'log')
    // Import after SUPERAGENT_DATA_DIR points at the temp dir so the db
    // singleton binds to it.
    const { chatIntegrationManager } = await import('./chat-integration-manager')
    try {
      await chatIntegrationManager.start()
      const started = logSpy.mock.calls.some((c) =>
        String(c[0]).includes('[ChatIntegrationManager] Started')
      )
      expect(started).toBe(true)
    } finally {
      chatIntegrationManager.stop()
      logSpy.mockRestore()
    }
  })
})
