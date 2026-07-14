import { test, expect, type Locator } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

/**
 * Agent secrets (the hardened `.env` store) end-to-end.
 *
 * This is a TRUE end-to-end test: a secret added through the UI must travel the
 * full path — setSecret → atomic `.env` write → listSecrets/getSecretEnvVars read
 * → createSession options — and actually reach the (mock) container. The mock
 * records the `availableEnvVars` it received into `.e2e-mock-recorder.jsonl`,
 * which we read back to prove delivery. It also confirms the secret persists
 * across a reload (the read side of the hardened store).
 */

const E2E_DATA_DIR = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')
const RECORDER_FILE = path.join(E2E_DATA_DIR, '.e2e-mock-recorder.jsonl')

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  initialMessage?: string
  availableEnvVars?: string[]
  timestamp: string
}

function readRecords(): MockRecord[] {
  if (!fs.existsSync(RECORDER_FILE)) return []
  return fs
    .readFileSync(RECORDER_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MockRecord)
}

/**
 * Wait for a matching record. The recorder file is shared across workers/tests,
 * so the predicate MUST filter by a test-unique attribute (here: the unique
 * initialMessage) — never assume the file starts empty.
 */
async function waitForRecord(predicate: (r: MockRecord) => boolean, timeoutMs = 12000): Promise<MockRecord> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readRecords().find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for record. Seen: ${JSON.stringify(readRecords().slice(-10), null, 2)}`)
}

test.describe('Agent Secrets (reach the container & persist)', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let agentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    agentName = `Secret Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(agentName)
  })

  test('a UI-added secret persists and is delivered to the container on the next session', async ({ page }, testInfo) => {
    // Unique, deterministic env var name. keyToEnvVar uppercases and turns
    // non-alphanumeric runs into underscores, so "E2E Secret W0T123" → "E2E_SECRET_W0T123".
    const tag = `W${testInfo.workerIndex}T${Date.now()}`
    const secretKey = `E2E Secret ${tag}`
    const expectedEnvVar = `E2E_SECRET_${tag.toUpperCase()}`

    // 1. Add the secret through the agent settings → Secrets tab.
    await agentPage.openSettings()
    await page.locator('[data-testid="agent-settings-nav-secrets"]').click()
    await page.locator('#secret-key').fill(secretKey)
    await page.locator('#secret-value').fill('super-secret-value')
    await page.getByRole('button', { name: 'Add Secret' }).click()

    // It shows up in the list (the env var name is rendered on the row).
    await expect(page.getByText(expectedEnvVar)).toBeVisible({ timeout: 10000 })

    // 2. Close settings.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="agent-settings-dialog"]')).not.toBeVisible()

    // 3. Persistence: reopen settings → Secrets and confirm the secret is read
    //    back from the on-disk `.env` (the hardened read side).
    await agentPage.openSettings()
    await page.locator('[data-testid="agent-settings-nav-secrets"]').click()
    await expect(page.getByText(expectedEnvVar)).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="agent-settings-dialog"]')).not.toBeVisible()

    // 4. Start a NEW session — the create-session path resolves the agent's
    //    secret env var names from the `.env` and passes them to the container.
    const sessionMessage = `Use the secret ${tag}`
    await page.locator('[data-testid="home-message-input"]').fill(sessionMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    // 5. The mock container recorded the env var name it received — assert the
    //    UI-added secret made it all the way through.
    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === sessionMessage
    )
    expect(record.availableEnvVars ?? []).toContain(expectedEnvVar)
  })

  test('a deleted secret no longer reaches the container', async ({ page }, testInfo) => {
    const tag = `D${testInfo.workerIndex}T${Date.now()}`
    const secretKey = `E2E Secret ${tag}`
    const expectedEnvVar = `E2E_SECRET_${tag.toUpperCase()}`

    // Add then immediately delete the secret.
    await agentPage.openSettings()
    await page.locator('[data-testid="agent-settings-nav-secrets"]').click()
    await page.locator('#secret-key').fill(secretKey)
    await page.locator('#secret-value').fill('to-be-removed')
    await page.getByRole('button', { name: 'Add Secret' }).click()

    await expect(page.getByText(expectedEnvVar)).toBeVisible({ timeout: 10000 })
    await page.locator(`[data-testid="delete-secret-${expectedEnvVar}"]`).click()
    await expect(page.getByText(expectedEnvVar)).toHaveCount(0, { timeout: 10000 })

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="agent-settings-dialog"]')).not.toBeVisible()

    // Start a new session — the deleted secret must NOT be among the env vars.
    const sessionMessage = `After delete ${tag}`
    await page.locator('[data-testid="home-message-input"]').fill(sessionMessage)
    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })

    const record = await waitForRecord(
      (r) => r.type === 'createSession' && r.initialMessage === sessionMessage
    )
    expect(record.availableEnvVars ?? []).not.toContain(expectedEnvVar)
  })

  /**
   * DialogContent and AlertDialogContent are `display: grid`. A direct child of a grid
   * container has `min-width: auto`, so its automatic minimum size is its min-content
   * width. One long unbreakable token drives that to thousands of pixels: the child
   * overflows the capped dialog and the dialog's own controls are laid out outside it,
   * unreachable. Both primitives neutralize it with `[&>*]:min-w-0`.
   *
   * Assert geometry, never the class name, so any other way of reintroducing the
   * overflow fails this too.
   */
  test('an unbreakable token must not strand dialog controls', async ({ page }) => {
    const longToken = 'a'.repeat(240)

    const expectContainedIn = async (control: Locator, container: Locator) => {
      await expect(control).toBeVisible({ timeout: 10000 })
      const containerBox = await container.boundingBox()
      const controlBox = await control.boundingBox()
      expect(containerBox).not.toBeNull()
      expect(controlBox).not.toBeNull()
      expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width)
    }

    await agentPage.openSettings()

    await test.step('DialogContent: an overlong secret key leaves Delete reachable', async () => {
      await page.locator('[data-testid="agent-settings-nav-secrets"]').click()
      await page.locator('#secret-key').fill(longToken)
      await page.locator('#secret-value').fill('overlong-key-value')
      await page.getByRole('button', { name: 'Add Secret' }).click()

      const deleteButton = page.locator(`[data-testid="delete-secret-${longToken.toUpperCase()}"]`)
      await expectContainedIn(deleteButton, page.locator('[data-testid="agent-settings-dialog"]'))
      // The click is the other half of the guard: a stranded button is not hittable.
      await deleteButton.click()
    })

    await test.step('AlertDialogContent: an overlong agent name leaves Confirm reachable and wraps', async () => {
      await page.locator('[data-testid="agent-settings-nav-general"]').click()
      // The confirmation quotes the live value of this field, so the dialog inflates
      // without the rename ever being saved.
      await page.locator('#agent-name').fill(longToken)
      await page.locator('[data-testid="delete-agent-button"]').click()

      const alertDialog = page.getByRole('alertdialog')
      const confirmButton = page.locator('[data-testid="confirm-button"]')
      await expectContainedIn(confirmButton, alertDialog)

      // Reachable controls are not enough: the name itself must wrap rather than paint
      // out through the alert's edge, which `overflow: visible` on the dialog allows.
      const descOverflow = await alertDialog
        .locator('p')
        .first()
        .evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(descOverflow).toBeLessThanOrEqual(0)

      await confirmButton.click()
    })
  })
})
