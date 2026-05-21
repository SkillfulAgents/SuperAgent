import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const E2E_DATA_DIR = path.join(__dirname, '..', '..', '.e2e-data')
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

  test('selecting Opus before sending the first message creates the session with the Opus model', async ({ page }, testInfo) => {
    // Use a test-unique initial message so we can find this test's record in
    // the worker-shared recorder file without picking up another test's data.
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `Opus first message ${tag}`

    // Open AgentHome (the new-session composer).
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Pick Opus in the composer options popover.
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="model-option-opus"]').click()

    // Send.
    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()

    // Wait for navigation to session view (signals the request reached the server).
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.model).toBe('opus')
  })

  test('switching the model mid-session sends the new model on the next message', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const followUp = `Now using Haiku ${tag}`

    // Create the session via AgentPage helper (uses default settings model — Opus).
    // `createAgent(prompt)` sends `prompt` as the first message, so we can use
    // testAgentName to uniquely identify this test's createSession record.
    await agentPage.createAgent(testAgentName)

    // Navigate into the session view by selecting the agent (createAgent leaves us on agent-home).
    // The session was created with the initial message, so just open it.
    await agentPage.expandAgent(testAgentName)
    // First session under the agent — click the first session link.
    const sessionLink = page.locator('[data-testid^="session-item-"]').first()
    await sessionLink.click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()

    // Initial createSession recorded with first-session Opus default.
    // Filter on initialMessage — agentSlug stays as `untitled-XXXXX` even after
    // the display-name rename, so it isn't a stable test-unique key.
    const initialCreate = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === testAgentName
    )
    expect(initialCreate.model).toBe('opus')

    // Switch to Haiku in the in-session composer. The popover closes after a
    // pick, so reopen it to switch effort.
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="model-option-haiku"]').click()

    // Also switch effort to 'low' so we can assert both flow through.
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="effort-option-low"]').click()

    // Send a follow-up — content tag makes this record uniquely identifiable.
    await sessionPage.sendMessage(followUp)

    const sendRecord = await waitForRecord(
      (r) => r.type === 'sendMessage' && r.content === followUp
    )
    expect(sendRecord.model).toBe('haiku')
    expect(sendRecord.effort).toBe('low')
  })

  test('switching from Opus+ExtraHigh to Sonnet auto-resets effort to High on the next send', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `xhigh→sonnet auto-reset ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Pick Opus, then Extra High (Opus-only effort).
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="model-option-opus"]').click()
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="effort-option-xhigh"]').click()

    // Switch to Sonnet — popover's auto-reset effect should clamp effort back
    // to High since Sonnet doesn't allow xhigh.
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await page.locator('[data-testid="model-option-sonnet"]').click()

    // Trigger should now read "Sonnet · High" (effort was auto-reset).
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('High')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).not.toContainText('Extra High')

    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.model).toBe('sonnet')
    expect(record.effort).toBe('high')
  })

  test('AgentHome trigger displays the family of the user pinned default model', async ({ page }, testInfo) => {
    // Regression: settings stores `agentModel` as a pinned ID
    // ('claude-opus-4-7') while composer's `composerModels` are keyed by
    // family alias. When AgentHome falls back to settings (i.e. the agent
    // already has at least one session, so isFirstSession is false), the
    // popover trigger must still resolve to the right family — otherwise the
    // user sees one model in the UI while a different one goes out on the
    // wire.
    const tag = `${testInfo.workerIndex}-${Date.now()}`

    // Create one session so AgentHome's `isFirstSession` becomes false on the
    // next visit — that's what triggers the settings-fallback codepath.
    await agentPage.createAgent(`First message ${tag}`)

    // We're back on agent-home. With the default `agentModel:
    // "claude-opus-4-7"` setting, the trigger must show Opus, not Sonnet.
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('Opus 4.7')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).not.toContainText('Sonnet')

    // Send a message without touching the popover — assert the wire model
    // matches the family the trigger displayed.
    const followUp = `Default-pinned message ${tag}`
    await page.locator('[data-testid="home-message-input"]').fill(followUp)
    await page.locator('[data-testid="home-send-button"]').click()

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === followUp
    )
    // Match family-shape rather than the exact pinned ID so the test stays
    // robust to future agentModel default bumps.
    expect(record.model).toContain('opus')
  })

  test('Extra High and Max effort options are hidden for non-Opus families', async ({ page }) => {
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Default starts on Opus (preferredFamily for AgentHome) — confirm xhigh/max
    // are visible there first so the assertion has a meaningful contrast.
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await expect(page.locator('[data-testid="effort-option-xhigh"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-max"]')).toBeVisible()

    // Switch to Sonnet, reopen the popover, and confirm xhigh/max disappear
    // while low/medium/high stay.
    await page.locator('[data-testid="model-option-sonnet"]').click()
    await page.locator('[data-testid="composer-options-trigger"]').click()
    await expect(page.locator('[data-testid="effort-option-low"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-medium"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-high"]')).toBeVisible()
    await expect(page.locator('[data-testid="effort-option-xhigh"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="effort-option-max"]')).toHaveCount(0)
  })
})
