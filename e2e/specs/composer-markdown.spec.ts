import { expect, test } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

test.describe('composer Markdown blocks', () => {
  let agentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    const appPage = new AppPage(page)
    const agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    agentName = `Composer Markdown ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(agentName)
  })

  test('live-renders headings and lists from keyboard input and pasted Markdown', async ({ page }) => {
    const input = page.locator('[data-testid="home-message-input"]')

    const collapsedHeight = await input.evaluate((element) => element.clientHeight)
    await page.getByRole('button', { name: 'Expand input' }).click()
    await expect.poll(() => input.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(collapsedHeight + 100)
    await page.getByRole('button', { name: 'Shrink input' }).click()
    await expect.poll(() => input.evaluate((element) => element.clientHeight))
      .toBeLessThanOrEqual(120)

    await input.fill('intro')
    await input.press('Shift+Enter')
    await input.pressSequentially('## Hello')
    await input.press('Shift+Enter')
    await input.pressSequentially('- first')
    await input.press('Shift+Enter')
    await input.pressSequentially('- second')

    await expect(input.locator('h2')).toHaveText('Hello')
    await expect(input.locator('ul').first().locator(':scope > li')).toHaveCount(2)

    await input.fill('')
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData(
        'text/plain',
        '## Pasted heading\n\n- pasted one\n- pasted two\n\n1. ordered one\n2. ordered two'
      )
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }))
    })

    await expect(input.locator('h2')).toHaveText('Pasted heading')
    await expect(input.locator('ul li')).toHaveCount(2)
    await expect(input.locator('ol li')).toHaveCount(2)
  })

  test('keeps the caret visible after a long Markdown paste', async ({ page }) => {
    const input = page.locator('[data-testid="home-message-input"]')
    await input.evaluate((element) => {
      element.style.height = '80px'
      element.style.minHeight = '80px'
      element.style.maxHeight = '80px'
      element.style.overflowY = 'auto'
      const clipboardData = new DataTransfer()
      clipboardData.setData(
        'text/plain',
        Array.from({ length: 40 }, (_, index) => `- pasted item ${index + 1}`).join('\n')
      )
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }))
    })

    await expect(input.locator('li')).toHaveCount(40)
    await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  })

  test('creates a code block before session Enter-to-send', async ({ page }) => {
    const agentPage = new AgentPage(page)
    const sessionPage = new SessionPage(page)
    await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentName))
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()
    const input = page.locator('[data-testid="message-input"]')

    await input.pressSequentially('```typescript')
    await input.press('Enter')
    await expect(input.locator('pre')).toBeVisible()
  })

  test('submits a rendered session list with Cmd+Enter', async ({ page }) => {
    const agentPage = new AgentPage(page)
    const sessionPage = new SessionPage(page)
    await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentName))
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible()
    const input = page.locator('[data-testid="message-input"]')

    await input.pressSequentially('- list item')
    await expect(input.locator('li')).toHaveText('list item')
    await input.press('Meta+Enter')
    await expect(input).toHaveText('')
  })
})
