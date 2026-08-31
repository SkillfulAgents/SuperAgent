import { expect, test } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { mockRecorder } from '../helpers/mock-recorder'

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  initialMessage?: string
  availableEnvVars?: string[]
}

const recorder = mockRecorder<MockRecord>()

test.describe('composer secret detection', () => {
  let agentPage: AgentPage

  test.beforeEach(async ({ page }, testInfo) => {
    const appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Composer Secret ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('saves a detected key, masks the draft, and sends only the .env placeholder', async ({ page }, testInfo) => {
    const tag = `W${testInfo.workerIndex}T${Date.now()}`
    const rawKey = ['sk-', `proj-${tag}-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z`].join('')
    const keyName = `Deploy Key ${tag}`
    const envVar = `DEPLOY_KEY_${tag.toUpperCase()}`
    const input = page.locator('[data-testid="home-message-input"]')

    await input.fill('Use this credential:')
    await input.press('Shift+Enter')
    await input.pressSequentially(rawKey)
    await expect(page.locator('[data-testid="potential-secret"]')).toHaveText(rawKey)
    await expect(page.getByText('Is this a Key?')).toBeVisible()

    await page.getByRole('button', { name: 'Send securely to the agent' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send key securely' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Secret value')).toHaveValue(rawKey)
    await dialog.getByLabel('Key name').fill(keyName)
    await dialog.getByRole('button', { name: 'Save securely' }).click()

    await expect(dialog).not.toBeVisible()
    await expect(input).toContainText('Use this credential:')
    await expect(input.locator('br[data-soft-break="true"]')).toHaveCount(1)
    await expect(input).toContainText(`[${keyName} | *********]`)
    await expect(page.locator('[data-testid="secured-secret"]')).toHaveText(`[${keyName} | *********]`)
    await expect(page.getByText('Is this a Key?')).toHaveCount(0)

    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15_000 })

    const expectedMessage = `Use this credential:\n[Key saved to .env - ${envVar}]`
    const record = await recorder.waitFor((candidate) => candidate.type === 'createSession' && candidate.initialMessage === expectedMessage
    )
    expect(record.initialMessage).not.toContain(rawKey)
    expect(record.availableEnvVars ?? []).toContain(envVar)
  })

  test('draws a wrapped dotted highlight and dismisses it without editing the key', async ({ page }) => {
    const rawKey = ['sk-', `proj-${'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'.repeat(4)}`].join('')
    const input = page.locator('[data-testid="home-message-input"]')

    await input.fill(rawKey)
    const highlight = page.locator('[data-testid="potential-secret"]')
    await expect(highlight).toBeVisible()
    expect(await highlight.evaluate((element) => element.getClientRects().length)).toBeGreaterThan(1)
    expect(await highlight.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('dotted')

    await page.getByRole('button', { name: 'Dismiss key suggestion' }).click()
    await expect(highlight).toHaveCount(0)
    await expect(input).toHaveText(rawKey)
  })

  test('removes a saved key pill atomically with Backspace', async ({ page }) => {
    const rawKey = ['gh', 'p_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    const input = page.locator('[data-testid="home-message-input"]')

    await input.fill(`Before ${rawKey} after`)
    await page.getByRole('button', { name: 'Send securely to the agent' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send key securely' })
    await dialog.getByLabel('Key name').fill('GitHub Token')
    await dialog.getByRole('button', { name: 'Save securely' }).click()

    const pill = page.locator('[data-testid="secured-secret"]')
    await expect(pill).toHaveText('[GitHub Token | *********]')
    await expect(pill).toHaveClass(/outline-amber-500\/70/)
    await input.focus()
    await pill.evaluate((element) => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await input.press('Backspace')

    await expect(input).toHaveText('Before  after')
    await expect(pill).toHaveCount(0)
  })
})
