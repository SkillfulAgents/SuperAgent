import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test'
import { AppPage } from '../../pages/app.page'

interface Person { id: string; name: string; email: string; context: BrowserContext }
interface Notification { type: string; title: string; body: string; sessionId: string; recipientUserId: string | null }

async function mentionsFor(request: APIRequestContext): Promise<Notification[]> {
  const response = await request.get('/api/notifications')
  expect(response.ok()).toBeTruthy()
  const { items } = await response.json() as { items: Notification[] }
  return items.filter((item) => item.type === 'session_mention')
}

test('tagging a teammate shares the agent first, notifies only them, and leaves the agent alone', async ({ browser, page, baseURL }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const contexts: BrowserContext[] = []
  const people: Person[] = []
  try {
    // Unique words, so `@<word>` finds exactly one person.
    for (const [index, name] of [`Olivia O${stamp}`, `Sara S${stamp}`, `Mike M${stamp}`].entries()) {
      const context = index === 0 ? page.context() : await browser.newContext({ baseURL })
      if (index > 0) contexts.push(context)
      const email = `mentions-${stamp}-${index}@example.test`
      const response = await context.request.post('/api/auth/sign-up/email', { data: { name, email, password: 'CollaborationTesting123!' } })
      expect(response.ok()).toBeTruthy()
      const { user } = await response.json()
      people.push({ id: user.id, name, email, context })
      expect((await context.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
    }
    const [owner, sara, mike] = people

    const created = await page.request.post('/api/agents', { data: { name: `Mentions ${stamp}` } })
    expect(created.ok()).toBeTruthy()
    const agent = await created.json() as { slug: string }
    const endpoint = `/api/agents/${agent.slug}`
    // Mike can open the agent; Sara cannot, yet.
    expect((await page.request.post(`${endpoint}/access`, { data: { userId: mike.id, role: 'user' } })).status()).toBe(201)
    const session = await page.request.post(`${endpoint}/sessions`, { data: { message: 'Draft the launch plan' } })
    expect(session.ok()).toBeTruthy()
    const { id: sessionId } = await session.json() as { id: string }

    // A cold dev server compiles the app on the first load.
    const app = new AppPage(page)
    await app.goto()
    await app.waitForAppLoaded(60_000)
    await page.goto(`/agents/${agent.slug}/sessions/${sessionId}`)
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('message-assistant').first()).toBeVisible({ timeout: 30_000 })

    // Opening on a teammate only notifies them. Sara is offered to the owner with no access yet.
    await input.click()
    await input.pressSequentially(`@S${stamp}`)
    const saraOption = page.getByTestId(`mention-option-user-${sara.id}`)
    await expect(saraOption).toContainText('No access yet')
    await page.keyboard.press('Enter')
    await expect(input.getByTestId('user-mention')).toContainText(`@${sara.name}`)
    await input.pressSequentially('look at this plan')
    await expect(page.getByTestId('mention-notify-only-hint')).toHaveText(`Only notifies ${sara.name}. The agent won't reply.`)
    const assistantReplies = await page.getByTestId('message-assistant').count()
    await page.keyboard.press('Enter')

    const share = page.getByTestId('mention-access-dialog')
    await expect(share).toContainText(`Share this agent with ${sara.name}?`)
    await share.getByTestId('mention-share-role').click()
    await page.getByRole('option', { name: 'Viewer Can view sessions only' }).click()
    await share.getByRole('button', { name: 'Share and send' }).click()
    await expect(share).not.toBeVisible()

    const silent = page.getByTestId('message-user').filter({ hasText: 'look at this plan' })
    await expect(silent.getByTestId('user-mention')).toContainText(`@${sara.name}`)
    await expect(silent.getByTestId('mention-notified')).toHaveText(`Notified ${sara.name}`)
    await expect(silent).not.toContainText('Mentioned')
    const members = await (await page.request.get(`${endpoint}/members`)).json() as Array<{ id: string; role: string }>
    expect(members.find((member) => member.id === sara.id)?.role).toBe('viewer')

    // Only Sara hears of it.
    await expect.poll(async () => (await mentionsFor(sara.context.request)).map((item) => item.title)).toEqual([`${owner.name} mentioned you`])
    const [saraMention] = await mentionsFor(sara.context.request)
    expect(saraMention).toMatchObject({ sessionId, body: `@${sara.name} look at this plan`, recipientUserId: sara.id })
    expect(await mentionsFor(mike.context.request)).toEqual([])
    expect(await mentionsFor(page.request)).toEqual([])

    // Sara finds it in her inbox and opens the chat it points at.
    // Until she looks, the bell and the agent's row carry a purple @ rather than a dot.
    const saraPage = await sara.context.newPage()
    await saraPage.goto('/notifications')
    const bellMention = saraPage.getByTestId('notifications-button').getByLabel('mentioned you')
    await expect(bellMention).toBeVisible({ timeout: 30_000 })
    const saraAgentRow = saraPage.locator('[data-sidebar="menu-button"]').filter({ has: saraPage.getByTestId(`agent-item-${agent.slug}`) })
    await expect(saraAgentRow.getByLabel('mentioned you')).toBeVisible()
    await saraPage.getByText(`${owner.name} mentioned you`).click()
    await expect(saraPage).toHaveURL(new RegExp(`/sessions/${sessionId}`))
    await expect(saraPage.getByTestId('message-user').filter({ hasText: 'look at this plan' }).getByTestId('mention-notified')).toBeVisible()
    await expect.poll(async () => (await (await sara.context.request.get('/api/notifications/unread-count')).json())).toEqual({ count: 0, mentions: 0 })
    await expect(bellMention).toHaveCount(0, { timeout: 15_000 })

    // A tag mid-message is an ordinary turn, with the teammate's email for the agent.
    await input.click()
    await input.pressSequentially('ping ')
    await input.pressSequentially(`@M${stamp}`)
    await expect(page.getByTestId(`mention-option-user-${mike.id}`)).toContainText(mike.email)
    await page.keyboard.press('Enter')
    await input.pressSequentially('when the plan is ready')
    await expect(page.getByTestId('mention-notify-only-hint')).toHaveCount(0)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('mention-access-dialog')).toHaveCount(0)
    const loud = page.getByTestId('message-user').filter({ hasText: 'when the plan is ready' })
    await expect(loud.getByTestId('user-mention')).toContainText(`@${mike.name}`)
    await expect(loud.getByTestId('mention-notified')).toHaveCount(0)
    // One reply in all since the note: the note itself ran no turn.
    await expect(page.getByTestId('message-assistant')).toHaveCount(assistantReplies + 1, { timeout: 30_000 })
    await expect.poll(async () => (await mentionsFor(mike.context.request)).length).toBe(1)

    const { messages } = await (await page.request.get(`${endpoint}/sessions/${sessionId}/messages?limit=50`)).json() as { messages: Array<{ content: { text: string } }> }
    const sent = messages.map((message) => message.content.text).find((text) => text.includes('when the plan is ready'))
    expect(sent).toContain(`- @${mike.name}: teammate, ${mike.email} (user id ${mike.id})`)
  } finally {
    for (const context of contexts) await context.close()
  }
})
