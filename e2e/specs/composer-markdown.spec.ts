import { expect, test, type Locator } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// An Escape sent the instant the link card opens was sometimes missed (seen in the Todo dialog); waiting for its open animation keeps these steps stable.
const cardSettled = (card: Locator) => card.evaluate((el) => Promise.all(el.closest('[role=dialog]')?.getAnimations().map((animation) => animation.finished) ?? []))

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

  test('links pasted URLs over a selection and shows the URL on click', async ({ page }) => {
    const input = page.locator('[data-testid="home-message-input"]')

    // Typed, not fill(): fill can return before the editor has read the text, so the selection below would miss it.
    await input.click()
    await input.pressSequentially('see docs')
    for (let i = 0; i < 'docs'.length; i++) await input.press('Shift+ArrowLeft')
    await input.evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', 'https://example.com/docs')
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    })
    await expect(input.locator('a[href="https://example.com/docs"]')).toHaveText('docs')
    await input.locator('a[href="https://example.com/docs"]').click()
    await expect(page.getByRole('button', { name: 'https://example.com/docs' })).toBeVisible()
    await input.click({ position: { x: 4, y: 8 } })
    await expect(page.getByRole('button', { name: 'https://example.com/docs' })).toBeHidden()

    await input.locator('a[href="https://example.com/docs"]').click()
    await cardSettled(page.getByRole('button', { name: 'https://example.com/docs' }))
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'https://example.com/docs' })).toBeHidden()

    await input.locator('a[href="https://example.com/docs"]').click()
    await page.keyboard.type('s')
    await expect(page.getByRole('button', { name: 'https://example.com/docs' })).toBeHidden()
  })

  test('closes only the link card on Escape inside the Todo draft', async ({ page, request }) => {
    const before = (await (await request.get('/api/user-settings')).json()).experiments?.['todo-board'] === true
    await request.put('/api/user-settings', { data: { experiments: { 'todo-board': true } } })
    try {
      await page.goto('/todo')
      await page.locator('[data-testid="todo-new-draft"]').click()
      const dialog = page.locator('[data-testid="todo-draft-dialog"]')
      const editor = page.locator('[data-testid="todo-draft-editor"]')
      await editor.click()
      await editor.pressSequentially('Read the [docs](https://example.com/docs) first')
      await editor.locator('a[href="https://example.com/docs"]').click()
      const card = page.getByRole('button', { name: 'https://example.com/docs' })
      await expect(card).toBeVisible()

      await cardSettled(card)
      await page.keyboard.press('Escape')
      await expect(card).toBeHidden()
      await expect(dialog).toBeVisible()
    } finally {
      await request.put('/api/user-settings', { data: { experiments: { 'todo-board': before } } })
    }
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

  test('keeps ligatures and the arrow set enabled in the editor', async ({ page }) => {
    const input = page.locator('[data-testid="home-message-input"]')
    // prosemirror-view's stylesheet sets `font-feature-settings: "liga" 0` on
    // .ProseMirror, which would replace the inherited "ss08" (Slussen's arrow
    // set, drawing -> as an arrow); globals.css must win.
    await expect(input).toHaveClass(/ProseMirror/)
    const styles = await input.evaluate((element) => {
      const computed = window.getComputedStyle(element)
      return {
        ligatures: computed.fontVariantLigatures,
        features: computed.fontFeatureSettings,
      }
    })
    expect(styles.ligatures).toBe('normal')
    expect(styles.features).toBe('"ss08"')
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
