import { test, expect, type Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const E2E_DATA_DIR = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')
const RECORDER_FILE = path.join(E2E_DATA_DIR, '.e2e-mock-recorder.jsonl')

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  sessionId?: string
  content?: string
  initialMessage?: string
  effort?: string
  speed?: string
  model?: string
  timestamp: string
}

function readRecords(): MockRecord[] {
  if (!fs.existsSync(RECORDER_FILE)) return []
  const lines = fs.readFileSync(RECORDER_FILE, 'utf-8').trim().split('\n').filter(Boolean)
  return lines.map((l) => JSON.parse(l) as MockRecord)
}

/**
 * Wait for a matching record. The recorder file is shared across Playwright
 * workers and across all tests in this spec, so callers must filter by a
 * test-unique attribute (agentSlug or unique content) — never truncate the
 * file or assume it's empty at start.
 */
async function waitForRecord(
  predicate: (r: MockRecord) => boolean,
  timeoutMs = 10000
): Promise<MockRecord> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readRecords().find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for matching record. Records seen: ${JSON.stringify(readRecords(), null, 2)}`)
}

// The E2E seed (setup-e2e-data.js) grants Opus 4.8 a speed choice via a
// user-level catalog override; every other model keeps the builtin
// direct-Anthropic shape with no supportedSpeeds.
const OPUS_LATEST = 'claude-opus-4-8'
const HAIKU = 'claude-haiku-4-5'

// Open the composer popover and pick a concrete version. Picks don't dismiss
// the popover, so close it explicitly — callers assume a closed postcondition.
async function pickModel(page: Page, modelId: string) {
  await page.locator('[data-testid="composer-options-trigger"]').click()
  const version = page.locator(`[data-testid="model-pinned-${modelId}"]`)
  await version.waitFor({ state: 'visible' })
  await version.click()
  await page.keyboard.press('Escape')
}

async function pickSpeed(page: Page, speed: 'slow' | 'normal' | 'fast') {
  await page.locator('[data-testid="composer-options-trigger"]').click()
  await page.locator(`[data-testid="speed-option-${speed}"]`).click()
  await page.keyboard.press('Escape')
}

test.describe('Speed selection', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    // NOTE: do NOT truncate the recorder file — it's shared across Playwright
    // workers under one SUPERAGENT_DATA_DIR. Tests filter records by their
    // unique agent slug or message content instead.
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `Speed Agent ${testInfo.workerIndex}-${Date.now()}`
  })

  test('picking Fast in the composer sends the speed with the created session', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `Fast speed first message ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // The default model resolves to Opus latest, which carries the speed
    // override — the Speed section must render and Fast must go on the wire.
    await pickSpeed(page, 'fast')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('Fast')

    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.speed).toBe('fast')
  })

  test('an untouched speed selector sends no speed (server default wins)', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `Untouched speed message ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.speed).toBeUndefined()
  })

  test('changing speed mid-session sends the new speed on the next message', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const followUp = `Now going fast ${tag}`

    await agentPage.createAgent(testAgentName)
    await agentPage.expandAgent(testAgentName)
    const sessionLink = page.locator('[data-testid^="session-item-"]').first()
    await sessionLink.click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    // Pin the speed-capable model explicitly, then flip the speed to Fast.
    await pickModel(page, OPUS_LATEST)
    await pickSpeed(page, 'fast')

    await sessionPage.sendMessage(followUp)

    const sendRecord = await waitForRecord(
      (r) => r.type === 'sendMessage' && r.content === followUp
    )
    expect(sendRecord.speed).toBe('fast')
    expect(sendRecord.model).toBe(OPUS_LATEST)
  })

  test('the Speed section is hidden for models without a speed choice', async ({ page }) => {
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Opus (speed override) shows the section...
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await expect(page.locator('[data-testid="speed-option-fast"]')).toBeVisible()

    // ...switching to Haiku (builtin shape, no supportedSpeeds) hides it in place.
    await page.locator(`[data-testid="model-pinned-${HAIKU}"]`).click()
    await expect(page.locator('[data-testid="speed-option-fast"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})
