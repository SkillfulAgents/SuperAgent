import { expect, test } from '@playwright/test'
import MarkdownIt from 'markdown-it'
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

  test('restores a draft marker after unmatched brackets when its key is saved', async ({ page }) => {
    const prefix = `Restore ${Date.now()} literal`
    const input = page.getByTestId('home-message-input')
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', text)
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    }, `${prefix} [[ then [[secret:API_KEY|API%20Key]]`)
    await expect(input).toHaveText(`${prefix} [[ then [[secret:API_KEY|API%20Key]]`)

    await page.getByTestId('home-secrets-open-page').click()
    await page.getByTestId('secrets-add-button').click()
    await page.getByTestId('secret-dialog-key').fill('API Key')
    await page.getByTestId('secret-dialog-value').fill('synthetic-test-value')
    await page.getByTestId('secret-dialog-submit').click()
    await expect(page.getByTestId('secret-row-API_KEY')).toBeVisible()
    await page.getByTestId('secrets-back-button').click()
    await expect(input.getByTestId('secured-secret')).toBeVisible()

    await page.getByTestId('home-send-button').click()
    await expect(page.getByTestId('message-list')).toBeVisible()
    const record = await recorder.waitFor(candidate => candidate.type === 'createSession' && candidate.initialMessage?.startsWith(prefix) === true)
    expect(record.initialMessage).toBe(`${prefix} \\[\\[ then [Key saved to .env - API_KEY]`)
  })

  test('preserves heading and link chips after a case-only key rename', async ({ page }, testInfo) => {
    const tag = `W${testInfo.workerIndex}T${Date.now()}`
    const envVar = `PASTE_KEY_${tag.toUpperCase()}`
    const keyName = `Paste Key ${tag}`
    const marker = `[[secret:${envVar}|${encodeURIComponent(keyName)}]]`
    const slug = getCurrentAgentSlug(page)
    const saved = await page.request.post(`/api/agents/${slug}/secrets`, {
      data: { key: keyName, value: `sk-paste-${tag}` },
    })
    expect(saved.ok()).toBeTruthy()
    const renamed = await page.request.put(`/api/agents/${slug}/secrets/${envVar}`, {
      data: { key: keyName.toLowerCase() },
    })
    expect(renamed.ok()).toBeTruthy()
    await page.reload()
    const input = page.locator('[data-testid="home-message-input"]')

    await input.fill('')
    await input.evaluate((element, text) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', text)
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }))
    }, `## Deploy ${marker}\n\n[see ${marker}](https://x.com)`)

    await expect(input.locator('h2 [data-testid="secured-secret"]')).toHaveText(`[${keyName} | *********]`)
    await expect(input.locator('a [data-testid="secured-secret"]')).toHaveText(`[${keyName} | *********]`)
    await expect(input.locator('a')).toHaveAttribute('href', 'https://x.com')
    await input.screenshot({ path: testInfo.outputPath('heading-link-chips.png') })

    await page.locator('[data-testid="home-send-button"]').click()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15_000 })

    const expectedMessage = `## Deploy [Key saved to .env - ${envVar}]\n\n[see [Key saved to .env - ${envVar}]](https://x.com)`
    const record = await recorder.waitFor((candidate) => candidate.type === 'createSession' && candidate.initialMessage === expectedMessage
    )
    expect(record.initialMessage).not.toContain('[[secret:')
  })

  test('preserves pasted URL targets while keys load and the visible reference becomes a chip', async ({ page }) => {
    const slug = getCurrentAgentSlug(page)
    const saved = await page.request.post(`/api/agents/${slug}/secrets`, {
      data: { key: 'API Key', value: 'synthetic-test-value' },
    })
    expect(saved.ok()).toBeTruthy()
    let releaseSecrets!: () => void
    const secretsReady = new Promise<void>(resolve => { releaseSecrets = resolve })
    await page.route('**/api/agents/*/secrets', async route => {
      if (route.request().method() === 'GET') await secretsReady
      await route.continue()
    })
    await page.reload()
    const prefix = `Imported URL ${Date.now()}`
    const marker = '[[secret:API_KEY|API%20Key]]'
    const href = `https://example.com/${marker}`
    const src = `/favicon.ico?${marker}`
    const input = page.getByTestId('home-message-input')
    await input.evaluate((element, html) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/html', html)
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    }, `<p>${prefix} <a href="${href}">${href}</a><img src="${src}" alt="image"></p>`)
    await expect(input.locator('a')).toHaveAttribute('href', href)
    await expect(input.getByTestId('secured-secret')).toHaveCount(0)
    releaseSecrets()
    await expect(input.getByTestId('secured-secret')).toHaveCount(1)
    await page.getByTestId('home-send-button').click()
    const record = await recorder.waitFor(candidate => candidate.type === 'createSession' && candidate.initialMessage?.startsWith(prefix) === true)
    expect(record.initialMessage?.match(/Key saved to .env - API_KEY/g)).toHaveLength(1)
    const tokens = new MarkdownIt('commonmark').parse(record.initialMessage ?? '', {}).flatMap(token => token.children ?? [])
    expect(tokens.find(token => token.type === 'link_open')?.attrGet('href')).toBe('https://example.com/%5B%5Bsecret:API_KEY%7CAPI%20Key%5D%5D')
    expect(tokens.find(token => token.type === 'image')?.attrGet('src')).toBe('/favicon.ico?%5B%5Bsecret:API_KEY%7CAPI%20Key%5D%5D')
  })

  for (const deleteKey of [false, true]) {
    test(`preserves an image alt reference through submit${deleteKey ? ' after key deletion' : ''}`, async ({ page }) => {
      const slug = getCurrentAgentSlug(page)
      const saved = await page.request.post(`/api/agents/${slug}/secrets`, {
        data: { key: 'API Key', value: 'synthetic-test-value' },
      })
      expect(saved.ok()).toBeTruthy()
      await page.reload()
      const prefix = `Image ${Date.now()}`
      const title = '\\[\\[secret:API_KEY|API%20Key\\]\\]'
      const input = page.getByTestId('home-message-input')
      await input.evaluate((element, text) => {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text/plain', text)
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
      }, `${prefix} ![alt [[secret:API_KEY|API%20Key]](next)](/favicon.ico "${title}")`)
      await expect(input.locator('img[src="/favicon.ico"]')).toHaveAttribute('alt', 'alt [[secret:API_KEY|API%20Key]](next)')
      await expect(input.locator('img[src="/favicon.ico"]')).toHaveAttribute('title', '[[secret:API_KEY|API%20Key]]')
      if (deleteKey) {
        await page.getByTestId('home-secrets-open-page').click()
        await page.getByTestId('secret-menu-API_KEY').click()
        await page.getByTestId('delete-secret-API_KEY').click()
        await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
        await expect(page.getByTestId('secret-row-API_KEY')).toHaveCount(0)
        await page.getByTestId('secrets-back-button').click()
        await expect(input.locator('img[src="/favicon.ico"]')).toHaveAttribute('alt', 'alt [[secret:API_KEY|API%20Key]](next)')
      }
      await page.getByTestId('home-send-button').click()
      await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 15_000 })
      const record = await recorder.waitFor(candidate => candidate.type === 'createSession' && candidate.initialMessage?.startsWith(prefix) === true)
      const reference = deleteKey ? '[[secret:API_KEY|API%20Key]]' : '[Key saved to .env - API_KEY]'
      expect(record.initialMessage).toBe(`${prefix} ![alt ${reference}(next)](/favicon.ico "${title}")`)
    })
  }
})
