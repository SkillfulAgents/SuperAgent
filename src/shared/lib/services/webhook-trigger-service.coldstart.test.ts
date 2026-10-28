/**
 * Registration-sync coverage on the REAL module cycle.
 *
 * webhook-trigger-service.test.ts mocks @shared/lib/db and never observes the
 * fire-and-forget import of trigger-manager that createWebhookTrigger launches
 * to re-register endpoints with the webhook relay, so a broken dynamic import —
 * or an incomplete namespace out of the webhook-trigger-service ⇄
 * trigger-manager cycle — dies as an unhandled rejection that no test
 * attributes. This file deliberately uses the real db and the real
 * trigger-manager: the sync must run to completion and say so.
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
  // Open after SUPERAGENT_DATA_DIR points at the temp dir, as an entry point would.
  const { openDatabase } = await import('@shared/lib/db')
  await openDatabase()
})

afterAll(async () => {
  const { closeDatabase } = await import('@shared/lib/db')
  await closeDatabase()
  if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  if (prevE2eMock === undefined) delete process.env.E2E_MOCK
  else process.env.E2E_MOCK = prevE2eMock
  await fs.promises.rm(tempDataDir, { recursive: true, force: true }).catch(() => {})
})

describe('createWebhookTrigger registration sync (unmocked)', () => {
  it('completes the fire-and-forget trigger-manager import and sync', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const warnSpy = vi.spyOn(console, 'warn')
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
          String(c[0]).includes(`relay registrations synced (created ${id})`)
        )
        expect(completed).toBe(true)
      },
      { timeout: 15000, interval: 50 }
    )

    const failed = warnSpy.mock.calls.some((c) =>
      String(c[0]).includes('relay registration sync failed')
    )
    expect(failed).toBe(false)

    logSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
