/**
 * Cold-start nudge coverage on the REAL module cycle.
 *
 * webhook-trigger-service.test.ts mocks @shared/lib/db and never observes the
 * fire-and-forget import of trigger-manager that createWebhookTrigger launches,
 * so a broken dynamic import — or an incomplete namespace out of the
 * webhook-trigger-service ⇄ trigger-manager cycle — dies as an unhandled
 * rejection that no test attributes. This file deliberately uses the real db
 * and the real trigger-manager: the nudge must run to completion and say so.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tempDataDir: string
let prevDataDir: string | undefined
let prevE2eMock: string | undefined

beforeAll(async () => {
  prevDataDir = process.env.SUPERAGENT_DATA_DIR
  prevE2eMock = process.env.E2E_MOCK
  tempDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coldstart-'))
  process.env.SUPERAGENT_DATA_DIR = tempDataDir
  // Keep trackServerEvent from emitting real analytics for the created trigger.
  process.env.E2E_MOCK = 'true'
})

afterAll(async () => {
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  if (prevE2eMock === undefined) delete process.env.E2E_MOCK
  else process.env.E2E_MOCK = prevE2eMock
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

describe('createWebhookTrigger cold-start nudge (unmocked)', () => {
  it('completes the fire-and-forget trigger-manager import and poll', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const warnSpy = vi.spyOn(console, 'warn')
    // Import after SUPERAGENT_DATA_DIR points at the temp dir so the db
    // singleton binds to it.
    const { createWebhookTrigger } = await import('./webhook-trigger-service')

    const id = await createWebhookTrigger({
      agentSlug: 'coldstart-agent',
      kind: 'custom',
      triggerType: 'custom_webhook',
      prompt: 'probe the cold-start nudge',
      name: 'coldstart probe',
    })
    expect(id).toBeTruthy()

    await vi.waitFor(
      () => {
        const completed = logSpy.mock.calls.some((c) =>
          String(c[0]).includes(`cold-start nudge completed for trigger ${id}`)
        )
        expect(completed).toBe(true)
      },
      { timeout: 15000, interval: 50 }
    )

    const skipped = warnSpy.mock.calls.some((c) =>
      String(c[0]).includes('cold-start poll skipped')
    )
    expect(skipped).toBe(false)

    logSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
