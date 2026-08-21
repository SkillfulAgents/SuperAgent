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

// Composer is a flat list keyed by concrete id; the host resolves the selection
// to a concrete wire id before the (mock) container records it.
const OPUS_LATEST = 'claude-opus-4-8'
const OPUS_PINNED_OLDER = 'claude-opus-4-7'
const SONNET = 'claude-sonnet-4-6'
const HAIKU = 'claude-haiku-4-5'

// Open the composer popover and pick a concrete version directly (no "latest"
// row in the composer; versions are pin chips on their family row, revealed by
// the hover Playwright performs before clicking). Picking no longer dismisses
// the popover, so close it explicitly — callers assume a closed postcondition.
// The `family` arg is kept for call-site readability only.
async function pickModel(page: Page, _family: string, modelId: string) {
  await page.locator('[data-testid="composer-options-trigger"]').click()
  const version = page.locator(`[data-testid="model-pinned-${modelId}"]`)
  await version.waitFor({ state: 'visible' })
  await version.click()
  await page.keyboard.press('Escape')
}

test.describe('Model selection', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    // NOTE: do NOT truncate the recorder file — it's shared across Playwright
    // workers under one SUPERAGENT_DATA_DIR. Tests filter records by their
    // unique agent slug instead.
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    testAgentName = `Model Agent ${testInfo.workerIndex}-${Date.now()}`
  })

  test('selecting the latest Opus in the composer creates the session pinned to that concrete id', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `Opus first message ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Pick Opus 4.8 in the grouped composer (expand Opus → pick the version).
    await pickModel(page, 'opus', OPUS_LATEST)

    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()

    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.model).toBe(OPUS_LATEST)
  })

  test('pinning a specific older version survives the send (not collapsed to latest)', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `Pinned Opus 4.7 ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Pin Opus 4.7 — the older version must reach the container exactly, not
    // get collapsed up to the family latest.
    await pickModel(page, 'opus', OPUS_PINNED_OLDER)

    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.model).toBe(OPUS_PINNED_OLDER)
  })

  test('switching the model mid-session sends the new concrete model on the next message', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const followUp = `Now using Haiku ${tag}`

    await agentPage.createAgent(testAgentName)
    await agentPage.expandAgent(testAgentName)
    const sessionLink = page.locator('[data-testid^="session-item-"]').first()
    await sessionLink.click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    // Switch to Haiku in the in-session composer, then drop effort to low.
    // Effort no longer auto-closes the popover, so dismiss it before sending.
    await pickModel(page, 'haiku', HAIKU)
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="effort-option-low"]').click()
    await page.keyboard.press('Escape')

    await sessionPage.sendMessage(followUp)

    const sendRecord = await waitForRecord(
      (r) => r.type === 'sendMessage' && r.content === followUp
    )
    expect(sendRecord.model).toBe(HAIKU)
    expect(sendRecord.effort).toBe('low')
  })

  test('switching from Opus+ExtraHigh to Sonnet auto-resets effort to Medium on the next send', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `xhigh→sonnet auto-reset ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    await pickModel(page, 'opus', OPUS_LATEST)
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="effort-option-xhigh"]').click()

    // Picks keep the popover open, so the model list is right there — pick
    // Sonnet directly, then dismiss. The popover's auto-reset clamps effort
    // back to Medium since Sonnet doesn't allow xhigh.
    await page.locator(`[data-testid="model-pinned-${SONNET}"]`).click()
    await page.keyboard.press('Escape')

    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('Medium')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).not.toContainText('Extra High')

    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.model).toBe(SONNET)
    expect(record.effort).toBe('medium')
  })

  test('the default bare-alias model resolves to a concrete id on the wire', async ({ page }, testInfo) => {
    // The default `agentModel` setting is the bare alias 'opus'. AgentHome's
    // trigger must display the resolved Opus model, and a send without touching
    // the popover must put the resolved concrete id on the wire.
    const tag = `${testInfo.workerIndex}-${Date.now()}`

    await agentPage.createAgent(`First message ${tag}`)

    // Back on agent-home: the trigger shows the resolved Opus model (not Sonnet).
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('Opus')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).not.toContainText('Sonnet')

    const followUp = `Default-alias message ${tag}`
    await page.locator('[data-testid="home-message-input"]').fill(followUp)
    await page.locator('[data-testid="home-send-button"]').click()

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === followUp
    )
    // Bare 'opus' resolves to its concrete latest id — match family-shape so the
    // test survives future default-version bumps.
    expect(record.model).toContain('opus')
    expect(record.model).not.toBe('opus')
  })

  test('Extra High and Max effort options are hidden for non-Opus families', async ({ page }) => {
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Default starts on Opus — confirm xhigh/max are visible there first.
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await expect(page.locator('[data-testid="effort-option-xhigh"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-max"]')).toBeVisible()

    // Switch to Sonnet — the pick keeps the popover open, so the effort ticks
    // swap in place: xhigh/max disappear immediately.
    await page.locator(`[data-testid="model-pinned-${SONNET}"]`).click()
    await expect(page.locator('[data-testid="effort-option-low"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-medium"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-high"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-xhigh"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="effort-option-max"]')).toHaveCount(0)
  })
})
