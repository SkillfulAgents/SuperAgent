import { expect, test, type Locator, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage, getCurrentAgentSlug } from '../pages/agent.page'
import { mockRecorder } from '../helpers/mock-recorder'

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  initialMessage?: string
  availableEnvVars?: string[]
}

const recorder = mockRecorder<MockRecord>()

async function paste(input: Locator, content: string, mimeType = 'text/plain') {
  await input.evaluate((element, { content, mimeType }) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData(mimeType, content)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, { content, mimeType })
}

async function saveKey(page: Page, key = 'API Key', value = 'synthetic-test-value') {
  const saved = await page.request.post(`/api/agents/${getCurrentAgentSlug(page)}/secrets`, { data: { key, value } })
  expect(saved.ok()).toBeTruthy()
}

test.describe('composer secret detection', () => {
  let agentPage: AgentPage

  test.beforeEach(async ({ page }, testInfo) => {
    const appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Composer Secret ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('saves a detected key, paints a masked pill, and starts the session with only the .env placeholder', async ({ page }, testInfo) => {
    const tag = `W${testInfo.workerIndex}T${Date.now()}`
    const rawKey = ['sk-', `proj-${tag}-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z`].join('')
    const keyName = 'sk-openai-production-key'
    const envVar = 'SK_OPENAI_PRODUCTION_KEY'
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

  test('removes a pill as one unit with Backspace', async ({ page }) => {
    const rawKey = ['gh', 'p_Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    const input = page.locator('[data-testid="home-message-input"]')

    await input.fill(`Before ${rawKey}`)
    await page.getByRole('button', { name: 'Send securely to the agent' }).click()
    const dialog = page.getByRole('dialog', { name: 'Send key securely' })
    await dialog.getByLabel('Key name').fill('GitHub Token')
    await dialog.getByRole('button', { name: 'Save securely' }).click()

    const pill = input.getByTestId('secured-secret')
    await expect(pill).toHaveText('[GitHub Token | *********]')
    await input.focus()
    await input.press('End')
    await input.press('Backspace')

    await expect(pill).toHaveCount(0)
    await expect(input).toHaveText('Before ')
  })

  test('paints a pasted marker inside a heading and a link, and sends the placeholders', async ({ page }) => {
    await saveKey(page)
    await page.reload()
    const marker = '[[secret:API_KEY|API%20Key]]'
    const input = page.getByTestId('home-message-input')

    await paste(input, `## Deploy ${marker}\n\n[see ${marker}](https://x.com)`)

    await expect(input.locator('h2 [data-testid="secured-secret"]')).toHaveText('[API Key | *********]')
    await expect(input.locator('a [data-testid="secured-secret"]')).toHaveText('[API Key | *********]')
    await expect(input.locator('a')).toHaveAttribute('href', 'https://x.com')

    await page.getByTestId('home-send-button').click()
    const expectedMessage = '## Deploy [Key saved to .env - API_KEY]\n\n[see [Key saved to .env - API_KEY]](https://x.com)'
    await recorder.waitFor((candidate) => candidate.type === 'createSession' && candidate.initialMessage === expectedMessage)
  })

  test('flags a pill once its key is deleted and sends its marker instead of the placeholder', async ({ page }) => {
    await saveKey(page)
    await page.reload()
    const prefix = `Deleted ${Date.now()}`
    const marker = '[[secret:API_KEY|API%20Key]]'
    const input = page.getByTestId('home-message-input')

    await paste(input, `${prefix} ${marker}`)
    await expect(input.locator('[data-unbacked]')).toHaveCount(0)

    await page.getByTestId('home-secrets-open-page').click()
    await page.getByTestId('secret-menu-API_KEY').click()
    await page.getByTestId('delete-secret-API_KEY').click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByTestId('secret-row-API_KEY')).toHaveCount(0)
    await page.getByTestId('secrets-back-button').click()

    await expect(input.locator('[data-unbacked="true"] [data-testid="secured-secret"]')).toBeVisible()
    await page.getByTestId('home-send-button').click()
    await recorder.waitFor((candidate) => candidate.type === 'createSession' && candidate.initialMessage === `${prefix} ${marker}`)
  })
})
