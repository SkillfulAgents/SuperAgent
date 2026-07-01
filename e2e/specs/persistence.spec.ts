import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import {
  createAgent as createAgentViaApi,
  deleteAgentViaApi,
  expectAgentDeleted,
  findAgentByName,
  findSessionWithUserMessage,
  getAgentItem,
  gotoAgentHome,
  gotoAgentSession,
  listSessionMessages,
  messageContentIncludes,
  uniqueName,
  uniqueSuffix,
  waitForSessionIdle,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

function expectMessagesIncludeUserText(
  messages: Awaited<ReturnType<typeof listSessionMessages>>,
  text: string,
) {
  expect(
    messages.some((message) => message.type === 'user' && messageContentIncludes(message, text)),
  ).toBe(true)
}

async function openApp(page: Page) {
  const appPage = new AppPage(page)
  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  return appPage
}

// Aside from the deletion case itself, these tests leave their uniquely named
// agents in the per-run data dir and let setup-e2e-data reset them before the
// next run. Deleting agents while sibling workers list /api/agents can race
// session-summary file reads under load.
test.describe('Persistence', () => {
  test('UI-created agent persists after page reload', async ({ page, request }, testInfo) => {
    const appPage = await openApp(page)
    const agentPage = new AgentPage(page)
    const agentName = uniqueName(testInfo, 'Persist Agent')

    await agentPage.createAgent(agentName)
    const agent = await findAgentByName(request, agentName)

    await expect(getAgentItem(page, agent)).toBeVisible()

    await appPage.reload()

    await expect(getAgentItem(page, agent)).toBeVisible()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })

    const session = await findSessionWithUserMessage(request, agent, agentName)
    await waitForSessionIdle(request, agent, session).catch(() => {})
  })

  test('UI-sent messages persist after page reload', async ({ page, request }, testInfo) => {
    const agent = await createAgentViaApi(request, uniqueName(testInfo, 'Message Persist Agent'))
    const sessionPage = new SessionPage(page)
    const message = `Persistent message ${uniqueSuffix(testInfo)}`
    let session: TestSession | undefined

    await gotoAgentHome(page, agent)

    await sessionPage.sendMessage(message)
    await sessionPage.waitForResponse(15000)
    await sessionPage.expectUserMessage(message)
    await expect(sessionPage.getAssistantMessages().first()).toBeVisible()

    session = await findSessionWithUserMessage(request, agent, message)
    expectMessagesIncludeUserText(
      await listSessionMessages(request, agent, session),
      message,
    )

    const appPage = new AppPage(page)
    await appPage.reload()

    await gotoAgentSession(page, agent, session)
    await expect(sessionPage.getUserMessages().filter({ hasText: message }).first()).toBeVisible({ timeout: 10000 })
    expectMessagesIncludeUserText(
      await listSessionMessages(request, agent, session),
      message,
    )
    if (session) await waitForSessionIdle(request, agent, session).catch(() => {})
  })

  test('UI-deleted agent stays deleted after reload', async ({ page, request }, testInfo) => {
    const appPage = await openApp(page)
    const agentPage = new AgentPage(page)
    const agent = await createAgentViaApi(request, uniqueName(testInfo, 'Deletable Agent'))
    let deleted = false

    try {
      await gotoAgentHome(page, agent)
      await expect(getAgentItem(page, agent)).toBeVisible()

      await agentPage.deleteAgent()
      deleted = true
      await expectAgentDeleted(request, agent)
      await expect(getAgentItem(page, agent)).not.toBeVisible()

      await appPage.reload()

      await expect(getAgentItem(page, agent)).not.toBeVisible()
    } finally {
      if (!deleted) await deleteAgentViaApi(request, agent)
    }
  })

  test('multiple API-created agents persist after reload', async ({ page, request }, testInfo) => {
    const agents: TestAgent[] = []

    for (const label of ['Agent One', 'Agent Two', 'Agent Three']) {
      agents.push(await createAgentViaApi(request, uniqueName(testInfo, label)))
    }

    const appPage = await openApp(page)

    for (const agent of agents) {
      await expect(getAgentItem(page, agent)).toBeVisible()
    }

    await appPage.reload()

    for (const agent of agents) {
      await expect(getAgentItem(page, agent)).toBeVisible()
    }
  })
})
