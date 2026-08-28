import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import {
  createAgent,
  createSession,
  listSessions,
  listSessionMessages,
  messageContentIncludes,
  openAgentSession,
  uniqueName,
  waitForSessionIdle,
  type TestSession,
} from '../helpers/agents'

/**
 * Fork Session (SUP-247): right-click a session → Fork Session → a copy opens
 * immediately with the source's history; the source is untouched. Runs on the
 * mock runtime, which copies the JSONL the way the SDK does.
 */
test.describe('Fork Session', () => {
  async function fixture(page: Page, request: APIRequestContext, testInfo: TestInfo) {
    const agent = await createAgent(request, uniqueName(testInfo, 'Fork Agent'))
    const message = `Forkable message ${uniqueName(testInfo, 'm')}`
    const session = await createSession(request, agent, message)
    await waitForSessionIdle(request, agent, session)

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await openAgentSession(page, agent, session)
    return { agent, session, message }
  }

  test('forks from the sidebar menu and lands in the copy', async ({ page, request }, testInfo) => {
    const { agent, session: created, message } = await fixture(page, request, testInfo)
    // The create response always says "New Session"; naming lands asynchronously.
    // Read the settled name (and the source's message list) before forking.
    const session = (await listSessions(request, agent)).find((s) => s.id === created.id)!
    const sourceBefore = await listSessionMessages(request, agent, session)

    const row = page.locator(`[data-testid="session-item-${session.id}"]`)
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.click({ button: 'right' })
    await page.locator('[data-testid="fork-session-item"]').click()

    // Landed in the fork: URL changed, name carries the suffix, banner present.
    await expect(page).not.toHaveURL(new RegExp(`/sessions/${session.id}$`), { timeout: 15000 })
    await expect(page.locator('[data-testid="session-breadcrumb"]')).toContainText('(fork)')
    await expect(page.locator('[data-testid="fork-session-banner"]')).toContainText(`Forked from "${session.name}"`)

    // History carried, source unchanged.
    let fork: TestSession | undefined
    await expect.poll(async () => {
      fork = (await listSessions(request, agent)).find((s) => s.name === `${session.name} (fork)`)
      return !!fork
    }, { timeout: 15000 }).toBe(true)
    const forkMessages = await listSessionMessages(request, agent, fork!)
    expect(forkMessages.some((m) => messageContentIncludes(m, message))).toBe(true)
    expect(await listSessionMessages(request, agent, session)).toEqual(sourceBefore)
    expect((await listSessions(request, agent)).find((s) => s.id === session.id)?.name).toBe(session.name)

    // The fork is an ordinary session: send a message in it and see it land there.
    const input = page.locator('[data-testid="message-input"]')
    await input.fill('continue in the fork')
    await input.press('Enter')
    await expect.poll(async () => {
      const msgs = await listSessionMessages(request, agent, fork!)
      return msgs.some((m) => messageContentIncludes(m, 'continue in the fork'))
    }, { timeout: 15000 }).toBe(true)
    expect(await listSessionMessages(request, agent, session)).toEqual(sourceBefore)
  })

  test('carries the source composer draft and leaves the source draft in place', async ({ page, request }, testInfo) => {
    const { session } = await fixture(page, request, testInfo)
    const draft = `Unsent fork draft ${uniqueName(testInfo, 'd')}`
    const input = page.locator('[data-testid="message-input"]')
    await input.pressSequentially(draft)
    await expect(input).toHaveText(draft)

    const row = page.locator(`[data-testid="session-item-${session.id}"]`)
    await row.click({ button: 'right' })
    await page.locator('[data-testid="fork-session-item"]').click()

    await expect(page).not.toHaveURL(new RegExp(`/sessions/${session.id}$`), { timeout: 15000 })
    await expect(page.locator('[data-testid="message-input"]')).toHaveText(draft)

    await page.locator('[data-testid="fork-session-back-button"]').click()
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}$`), { timeout: 15000 })
    await expect(page.locator('[data-testid="message-input"]')).toHaveText(draft)
  })
})
