import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { AppPage } from '../../pages/app.page'

interface Person { id: string; name: string; email: string; context: BrowserContext }
interface Notification { type: string; title: string; body: string; sessionId: string }

async function threadNotices(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/api/notifications')
  expect(response.ok()).toBeTruthy()
  const { items } = await response.json() as { items: Notification[] }
  return items.filter((item) => item.type === 'session_mention' && item.title.endsWith('replied in a thread')).map((item) => item.title)
}

async function openSession(page: Page, slug: string, sessionId: string) {
  const app = new AppPage(page)
  await app.goto()
  // A cold dev server compiles the app on the first load.
  await app.waitForAppLoaded(60_000)
  await page.goto(`/agents/${slug}/sessions/${sessionId}`)
  await expect(page.getByTestId('message-input')).toBeVisible({ timeout: 15_000 })
}

test('a mention can be answered in a thread that tells everyone in it, stays out of the transcript, and can be shared with the agent', async ({ browser, page, baseURL }) => {
  test.setTimeout(150_000)
  const stamp = Date.now()
  const contexts: BrowserContext[] = []
  const people: Person[] = []
  try {
    for (const [index, name] of [`West W${stamp}`, `Graham G${stamp}`].entries()) {
      const context = index === 0 ? page.context() : await browser.newContext({ baseURL })
      if (index > 0) contexts.push(context)
      const email = `threads-${stamp}-${index}@example.test`
      const response = await context.request.post('/api/auth/sign-up/email', { data: { name, email, password: 'CollaborationTesting123!' } })
      expect(response.ok()).toBeTruthy()
      const { user } = await response.json()
      people.push({ id: user.id, name, email, context })
      expect((await context.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
    }
    const [west, graham] = people

    const created = await page.request.post('/api/agents', { data: { name: `Threads ${stamp}` } })
    expect(created.ok()).toBeTruthy()
    const agent = await created.json() as { slug: string }
    const endpoint = `/api/agents/${agent.slug}`
    expect((await page.request.post(`${endpoint}/access`, { data: { userId: graham.id, role: 'user' } })).status()).toBe(201)
    const session = await page.request.post(`${endpoint}/sessions`, { data: { message: 'Draft the launch plan' } })
    expect(session.ok()).toBeTruthy()
    const { id: sessionId } = await session.json() as { id: string }

    await openSession(page, agent.slug, sessionId)
    await expect(page.getByTestId('message-assistant').first()).toBeVisible({ timeout: 30_000 })

    // West tags Graham: a notify-only message, which can take a thread.
    const input = page.getByTestId('message-input')
    await input.click()
    await input.pressSequentially(`@G${stamp}`)
    await page.keyboard.press('Enter')
    await input.pressSequentially('can you check the pricing section?')
    await page.keyboard.press('Enter')
    const westMessage = page.getByTestId('message-user').filter({ hasText: 'can you check the pricing section?' })
    await expect(westMessage.locator('[data-notify-only]')).toBeVisible({ timeout: 15_000 })
    const assistantReplies = await page.getByTestId('message-assistant').count()

    // Graham answers in a thread, without tagging West again.
    const grahamPage = await graham.context.newPage()
    await openSession(grahamPage, agent.slug, sessionId)
    const grahamMessage = grahamPage.getByTestId('message-user').filter({ hasText: 'can you check the pricing section?' })
    await grahamMessage.hover()
    await grahamMessage.getByTestId('reply-in-thread').click()
    const grahamThread = grahamPage.getByTestId('thread-tray')
    await expect(grahamThread.getByTestId('thread-parent')).toContainText('can you check the pricing section?')
    await expect(grahamThread.getByTestId('thread-reply')).toHaveCount(0)
    await expect(grahamThread.getByTestId('thread-reply-input')).toBeFocused()
    await grahamThread.getByTestId('thread-reply-input').pressSequentially('Looks good, but the annual price is off by $10')
    await grahamPage.keyboard.press('Enter')
    await expect(grahamThread.getByTestId('thread-reply')).toHaveCount(1)
    await expect(grahamThread.getByTestId('thread-reply-input')).toHaveText('')

    // West hears of it, and the row under the message appears live.
    await expect.poll(() => threadNotices(page.request)).toEqual([`${graham.name} replied in a thread`])
    const westSummary = westMessage.getByTestId('thread-summary')
    await expect(westSummary).toContainText('1 reply', { timeout: 15_000 })

    // West opens the thread and replies; Graham is told, being in the thread.
    await westSummary.click()
    const westThread = page.getByTestId('thread-tray')
    await expect(westThread.getByTestId('thread-reply')).toContainText('annual price is off by $10')
    await westThread.getByTestId('thread-reply-input').click()
    await westThread.getByTestId('thread-reply-input').pressSequentially('Good catch, thanks')
    await page.keyboard.press('Enter')
    await expect(westThread.getByTestId('thread-reply')).toHaveCount(2)
    await expect.poll(() => threadNotices(graham.context.request)).toEqual([`${west.name} replied in a thread`])
    await expect(grahamThread.getByTestId('thread-reply')).toHaveCount(2, { timeout: 15_000 })
    await expect(grahamMessage.getByTestId('thread-summary')).toContainText('2 replies')

    // None of it reached the agent: no turn ran, nothing joined the transcript.
    await expect(page.getByTestId('message-assistant')).toHaveCount(assistantReplies)
    const transcript = async () => {
      const { messages } = await (await page.request.get(`${endpoint}/sessions/${sessionId}/messages?limit=50`)).json() as { messages: Array<{ content?: { text?: string } }> }
      return messages.map((message) => message.content?.text ?? '').join('\n')
    }
    expect(await transcript()).not.toContain('annual price is off by $10')

    await page.screenshot({ path: test.info().outputPath('thread-drawer.png') })

    // Sending it to the agent fills the session composer with the whole thread,
    // to edit and send: nothing reaches the agent until it is sent from there.
    await westThread.getByTestId('thread-share-with-agent').click()
    await expect(input).toContainText(`${west.name} and ${graham.name} were side-chatting in a thread`)
    expect(await transcript()).not.toContain('were side-chatting in a thread')
    await page.locator('form', { has: input }).getByTestId('send-button').click()
    await expect.poll(transcript, { timeout: 15_000 }).toContain(`${west.name} and ${graham.name} were side-chatting in a thread`)
    expect(await transcript()).toContain(`**${graham.name}:**`)
    expect(await transcript()).toContain('Looks good, but the annual price is off by $10')
    await expect(page.getByTestId('message-assistant')).toHaveCount(assistantReplies + 1, { timeout: 30_000 })
  } finally {
    for (const context of contexts) await context.close()
  }
})
