import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

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

// The recorder file is shared across Playwright workers, so callers must
// filter by a test-unique attribute (unique message content) — never truncate
// the file or assume it's empty at start.
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

// Distinct from the global default (Opus) so adoption is observable.
const HAIKU_PINNED = 'claude-haiku-4-5'

test.describe('Per-agent default model', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('setting a default on the homepage row flows to an untouched composer send', async ({ page }, testInfo) => {
    const tag = `${testInfo.workerIndex}-${Date.now()}`
    const initialMessage = `Agent default message ${tag}`

    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    // Unset default: the card shows the app-wide fallback and no reset affordance.
    const card = page.locator('[data-testid="home-default-model-card"]')
    await expect(card).toBeVisible()
    await expect(page.locator('[data-testid="home-default-model-reset"]')).not.toBeVisible()

    // Picks keep the popover open, so alias, pin, and effort all happen in ONE
    // visit. The "Haiku" row (and its Latest chip) stores the bare alias …
    await card.locator('[data-testid="settings-model-trigger"]').click()
    await page.locator('[data-testid="model-latest-haiku"]').click()
    await expect(card.locator('[data-testid="settings-model-trigger"]')).toContainText('Haiku · latest')

    // … its version chip pins the concrete release …
    await page.locator(`[data-testid="model-pinned-${HAIKU_PINNED}"]`).click()
    await expect(card.locator('[data-testid="settings-model-trigger"]')).toContainText('Haiku 4.5')

    // … and the effort slider sets the default effort. Then dismiss.
    await page.locator('[data-testid="effort-option-high"]').click()
    await expect(card.locator('[data-testid="settings-model-trigger"]')).toContainText('High')
    await page.keyboard.press('Escape')

    // A custom default surfaces the reset-to-global affordance.
    await expect(page.locator('[data-testid="home-default-model-reset"]')).toBeVisible()

    // The untouched composer adopts the agent default...
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('Haiku 4.5')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('High')

    // ...and the created session carries it on the wire.
    await page.locator('[data-testid="home-message-input"]').fill(initialMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === initialMessage
    )
    expect(record.model).toBe(HAIKU_PINNED)
    expect(record.effort).toBe('high')

    // Reset back to the global default: the card shows the Global hint again,
    // the untouched composer follows it, and the next session is created with
    // the app-wide default (bare 'opus' alias, resolved to the latest concrete
    // id on the wire).
    const resetMessage = `Reset to global message ${tag}`
    await page.goBack()
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    await page.locator('[data-testid="home-default-model-reset"]').click()
    await expect(page.locator('[data-testid="home-default-model-reset"]')).not.toBeVisible()
    await expect(card).toContainText('Global')
    await expect(page.locator('[data-testid="composer-options-trigger"]')).toContainText('Opus')

    await page.locator('[data-testid="home-message-input"]').fill(resetMessage)
    await page.locator('[data-testid="home-send-button"]').click()

    const resetRecord = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === resetMessage
    )
    expect(resetRecord.model).toBe('claude-opus-4-8')
  })
})
