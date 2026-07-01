import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { SessionPage } from '../pages/session.page'
import {
  createAgent as createAgentViaApi,
  gotoAgentHome,
  gotoAgentSession,
  waitForSessionIdle,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

function uniqueSuffix(testInfo: TestInfo) {
  return [
    testInfo.workerIndex,
    testInfo.repeatEachIndex,
    testInfo.retry,
    Date.now(),
    Math.random().toString(36).slice(2, 8),
  ].join('-')
}

function uniqueName(testInfo: TestInfo, label: string) {
  return `${label} ${uniqueSuffix(testInfo)}`
}

function userMessage(sessionPage: SessionPage, text: string) {
  // `.first()` is deliberate: during reconciliation the optimistic
  // pending-user-message ghost and the persisted message-user briefly coexist
  // (both carry data-testid="message-user"), so a bare toBeVisible() on the
  // unscoped match trips Playwright strict mode under CI load. These checks only
  // assert the message is PRESENT; the isolation guarantee is asserted by the
  // getMessageList().not.toContainText(...) lines below.
  return sessionPage.getUserMessages().filter({ hasText: text }).first()
}

async function currentSession(page: Page, agent: Pick<TestAgent, 'slug'>): Promise<TestSession> {
  await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/sessions/[^/?#]+$`), { timeout: 15000 })

  const match = page.url().match(new RegExp(`/agents/${agent.slug}/sessions/([^/?#]+)`))
  expect(match, `expected current URL to include a session id for ${agent.slug}`).not.toBeNull()

  return { id: match![1], name: '' }
}

async function waitForSessionsToSettle(
  request: Parameters<typeof waitForSessionIdle>[0],
  sessions: Array<{ agent: TestAgent; session: TestSession | undefined }>,
) {
  for (const { agent, session } of sessions) {
    if (session) await waitForSessionIdle(request, agent, session).catch(() => {})
  }
}

// These tests leave their uniquely named agents in the per-run data dir and let
// setup-e2e-data reset them before the next run. Deleting agents while sibling
// workers list /api/agents can race session-summary file reads under load.
test.describe('Cross-Session Message Isolation', () => {
  test('messages from one agent do not leak into another agent', async ({ page, request }, testInfo) => {
    const sessionPage = new SessionPage(page)
    const agentA = await createAgentViaApi(request, uniqueName(testInfo, 'Isolation A'))
    const agentB = await createAgentViaApi(request, uniqueName(testInfo, 'Isolation B'))
    const messageA = `slow response for agent A ${uniqueSuffix(testInfo)}`
    const messageB = `Hello from agent B ${uniqueSuffix(testInfo)}`
    let sessionA: TestSession | undefined
    let sessionB: TestSession | undefined

    try {
      await gotoAgentHome(page, agentA)
      await sessionPage.sendMessage(messageA)
      sessionA = await currentSession(page, agentA)

      await expect(userMessage(sessionPage, messageA)).toBeVisible({ timeout: 10000 })
      await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 5000 })

      await gotoAgentHome(page, agentB)
      await sessionPage.sendMessage(messageB)
      sessionB = await currentSession(page, agentB)

      await expect(userMessage(sessionPage, messageB)).toBeVisible({ timeout: 10000 })
      await expect(sessionPage.getMessageList()).not.toContainText(messageA)

      await gotoAgentSession(page, agentA, sessionA)

      const messageAList = sessionPage.getMessageList()
      await expect(messageAList).toBeVisible({ timeout: 5000 })
      await expect(userMessage(sessionPage, messageA)).toBeVisible({ timeout: 10000 })
      await expect(messageAList).not.toContainText(messageB)
    } finally {
      await waitForSessionsToSettle(request, [
        { agent: agentA, session: sessionA },
        { agent: agentB, session: sessionB },
      ])
    }
  })

  test('pending optimistic message is scoped to session', async ({ page, request }, testInfo) => {
    const sessionPage = new SessionPage(page)
    const agentA = await createAgentViaApi(request, uniqueName(testInfo, 'Pending A'))
    const agentB = await createAgentViaApi(request, uniqueName(testInfo, 'Pending B'))
    const messageA = `slow response test ${uniqueSuffix(testInfo)}`
    const messageB = `Quick message B ${uniqueSuffix(testInfo)}`
    let sessionA: TestSession | undefined
    let sessionB: TestSession | undefined

    try {
      await gotoAgentHome(page, agentA)
      await sessionPage.sendMessage(messageA)
      sessionA = await currentSession(page, agentA)

      await expect(userMessage(sessionPage, messageA)).toBeVisible({ timeout: 10000 })
      await expect(sessionPage.getStopButton()).toBeVisible({ timeout: 5000 })

      await gotoAgentHome(page, agentB)
      await sessionPage.sendMessage(messageB)
      sessionB = await currentSession(page, agentB)

      await expect(userMessage(sessionPage, messageB)).toBeVisible({ timeout: 10000 })
      await expect(sessionPage.getMessageList()).not.toContainText(messageA)

      await gotoAgentSession(page, agentA, sessionA)

      await expect(userMessage(sessionPage, messageA)).toBeVisible({ timeout: 10000 })
      await expect(sessionPage.getMessageList()).not.toContainText(messageB)
    } finally {
      await waitForSessionsToSettle(request, [
        { agent: agentA, session: sessionA },
        { agent: agentB, session: sessionB },
      ])
    }
  })
})
