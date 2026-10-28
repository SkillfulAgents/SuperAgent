import { test, expect } from '@playwright/test'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { mockBrowserStream } from '../helpers/browser-stream'
import {
  createAgent,
  gotoAgentHome,
  uniqueName,
  uniqueSuffix,
  type TestAgent,
} from '../helpers/agents'

// A background subagent can park on request_browser_input while the main turn
// stays open (its request arrives as a sidechain message, not on the main
// stream). The user-visible contract is the same as a main-agent request: the
// card shows AND the agent-level status flips to awaiting_input (orange dot).
// Regression: the sidechain path only broadcast the card, so the agent sat
// labeled "working" while it was actually blocked on the user.
test.describe('Subagent Browser Input Status', () => {
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let agent: TestAgent

  test.describe.configure({ timeout: 45000 })

  test.beforeEach(async ({ page, request }, testInfo) => {
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    agent = await createAgent(request, uniqueName(testInfo, 'Subagent Browser Agent'))
    await gotoAgentHome(page, agent)

    // Establish the session route and its event stream before issuing a
    // short-lived request. Otherwise the create-session navigation can miss
    // request events while the chat is still mounting.
    await sessionPage.sendMessage(`slow response establish subagent session ${uniqueSuffix(testInfo)}`)
    await sessionPage.waitForResponse(15000)
    await page.reload()
    await expect(sessionPage.getMessageList()).toBeVisible({ timeout: 15000 })
    await agentPage.waitForStatus('idle', 15000)
  })

  test('browser input requested by a subagent shows the card and flips status to awaiting_input', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`subagent browser input ${uniqueSuffix(testInfo)}`)

    // The request card appears (this worked before the fix)
    const card = page.getByTestId('browser-input-request')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('Log in to GitHub to finish the submission.')

    // THE BUG: agent status stayed 'working' for subagent-originated requests
    await agentPage.waitForStatus('awaiting_input', 15000)
  })

  test('preview and thread actions stay in sync across consecutive subagent requests', async ({ page }, testInfo) => {
    const sessionId = page.url().match(/\/sessions\/([^/?#]+)/)?.[1]
    if (!sessionId) throw new Error('Expected an established session')
    await page.route('**/api/agents/*/browser/status', (route) =>
      route.fulfill({ json: { active: true, sessionId } }),
    )
    await mockBrowserStream(page, 800, 450)

    const preview = page.getByTestId('browser-drawer-panel')
    await expect(preview).toBeVisible()
    // This node must survive both requests: remounting the tray masked the bug.
    await preview.evaluate((node) => node.setAttribute('data-request-test', 'same-preview'))

    for (const action of ['browser-tray-complete-btn', 'browser-input-decline-btn']) {
      await sessionPage.sendMessage(`subagent browser input ${uniqueSuffix(testInfo)}`)
      await expect(page.getByTestId('browser-input-request')).toBeVisible({ timeout: 15000 })
      await expect(preview).toHaveAttribute('data-request-test', 'same-preview')
      const controls = [
        page.getByTestId('browser-tray-complete-btn'),
        page.getByTestId('browser-tray-decline-btn'),
        page.getByTestId('browser-input-complete-btn'),
        page.getByTestId('browser-input-decline-btn'),
      ]
      for (const control of controls) await expect(control).toBeEnabled()

      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const decisionRoute = '**/api/agents/*/sessions/*/complete-browser-input'
      await page.route(decisionRoute, async (route) => {
        await held
        await route.continue()
      })
      try {
        await page.getByTestId(action).click()
        for (const control of controls) await expect(control).toBeDisabled()
      } finally {
        release()
      }

      await expect(page.getByTestId('browser-input-request')).toHaveCount(0, { timeout: 10000 })
      await expect(page.getByTestId('browser-tray-complete-btn')).toHaveCount(0)
      await agentPage.waitForStatus('idle', 15000)
      await page.unroute(decisionRoute)
    }
  })

  test('completing the request clears awaiting while the subagent resumes, then the session settles', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`subagent browser input ${uniqueSuffix(testInfo)}`)

    await expect(page.getByTestId('browser-input-request')).toBeVisible({ timeout: 15000 })
    await agentPage.waitForStatus('awaiting_input', 15000)

    await page.getByTestId('browser-input-complete-btn').click()

    // The subagent's tool_result comes back on the SIDECHAIN (the mock
    // preserves parent_tool_use_id) and the subagent resumes: the card must
    // drop and the status must leave awaiting_input BEFORE the session
    // settles — the mock holds the turn open ~2.5s after the resolve.
    // Regression: the sidechain result path never cleared isAwaitingInput,
    // so the UI stayed "needs input" behind a stale, replayable card.
    await expect(page.getByTestId('browser-input-request')).toHaveCount(0, { timeout: 10000 })
    await agentPage.waitForStatus('working', 5000)

    // …and the turn then completes normally.
    await agentPage.waitForStatus('idle', 15000)
  })

  test('a subagent that dies with a parked request drops the card and returns status to working', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`dead subagent input ${uniqueSuffix(testInfo)}`)

    // The subagent parks on browser input: card + awaiting, same as ever.
    await expect(page.getByTestId('browser-input-request')).toBeVisible({ timeout: 15000 })
    await agentPage.waitForStatus('awaiting_input', 15000)

    // The subagent then dies (sidechain result, no tool_result). Nothing can
    // answer the card anymore — the host must invalidate it: card gone and
    // status back to working while the main turn is still open.
    // Regression: the card sat orphaned until a turn boundary.
    await expect(page.getByTestId('browser-input-request')).toHaveCount(0, { timeout: 10000 })
    await agentPage.waitForStatus('working', 5000)

    // …and the main turn settles on its own afterwards.
    await agentPage.waitForStatus('idle', 15000)
  })

  test('declining the subagent browser input request returns the agent to idle', async ({ page }, testInfo) => {
    await sessionPage.sendMessage(`subagent browser input ${uniqueSuffix(testInfo)}`)

    await expect(page.getByTestId('browser-input-request')).toBeVisible({ timeout: 15000 })
    await agentPage.waitForStatus('awaiting_input', 15000)

    await page.getByTestId('browser-input-decline-btn').click()

    // Declining resolves the pending input; the mock ends the turn and the
    // awaiting state must not stick around.
    await expect(page.getByTestId('browser-input-request')).toHaveCount(0, { timeout: 10000 })
    await agentPage.waitForStatus('idle', 15000)
  })
})
