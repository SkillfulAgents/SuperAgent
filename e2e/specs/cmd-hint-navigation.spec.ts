/**
 * Hold-to-hint sidebar navigation: holding the primary modifier (⌘/Ctrl) past
 * a threshold overlays numbered badges on the sidebar nav targets (agent rows
 * plus an expanded agent's visible sub-rows, in document order), and
 * modifier+digit jumps to the matching target.
 *
 * The suite pins its agents to the front of the sidebar via the user-settings
 * agentOrder so they land inside the first nine hint slots, and reads the
 * badge numbers from the DOM rather than assuming absolute positions —
 * parallel workers create agents concurrently, and new agents sort above the
 * pinned order. Serial mode keeps the tests in this file from overwriting
 * each other's agentOrder.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import {
  createAgent,
  createSession,
  getAgentItem,
  uniqueName,
  type TestAgent,
} from '../helpers/agents'

test.describe.configure({ mode: 'serial' })

const HINT_BADGES = '[data-testid^="cmd-hint-"]'

async function pinAgentsFirst(request: APIRequestContext, agents: TestAgent[]) {
  const listResponse = await request.get('/api/agents')
  expect(listResponse.ok()).toBeTruthy()
  const all = await listResponse.json() as TestAgent[]

  const pinned = agents.map((agent) => agent.slug)
  const rest = all.map((agent) => agent.slug).filter((slug) => !pinned.includes(slug))
  const response = await request.put('/api/user-settings', {
    data: { agentOrder: [...pinned, ...rest] },
  })
  expect(response.ok()).toBeTruthy()
}

function hintNumber(testId: string | null): number {
  const digit = testId?.replace('cmd-hint-', '')
  expect(digit, `expected a cmd-hint testid, got ${testId}`).toMatch(/^[1-9]$/)
  return Number(digit)
}

/** Hold the modifier and wait for the hint overlay to appear. */
async function holdModifierForHints(page: Page) {
  await page.keyboard.down('ControlOrMeta')
  await expect(page.locator('[data-testid="cmd-hint-1"]')).toBeVisible({ timeout: 5000 })
}

test.describe('Cmd-hold sidebar navigation hints', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
  })

  async function loadApp() {
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  }

  test('holding the modifier reveals sequential hints; releasing hides them', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'CmdHint Reveal'))
    await pinAgentsFirst(request, [agent])
    await loadApp()

    await expect(page.locator(HINT_BADGES)).toHaveCount(0)

    await holdModifierForHints(page)
    try {
      // Badges are numbered 1..N (N <= 9) in document order.
      const numbers = (await page.locator(HINT_BADGES).evaluateAll(
        (els) => els.map((el) => el.getAttribute('data-testid')),
      )).map(hintNumber)
      expect(numbers.length).toBeGreaterThan(0)
      expect(numbers.length).toBeLessThanOrEqual(9)
      expect(numbers).toEqual(numbers.map((_, i) => i + 1))
    } finally {
      await page.keyboard.up('ControlOrMeta')
    }

    await expect(page.locator(HINT_BADGES)).toHaveCount(0)
  })

  test('a quick modifier tap does not reveal hints', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'CmdHint Tap'))
    await pinAgentsFirst(request, [agent])
    await loadApp()

    await page.keyboard.down('ControlOrMeta')
    await page.keyboard.up('ControlOrMeta')

    // Wait past the hold threshold to prove the released tap cancelled the reveal.
    await page.waitForTimeout(900)
    await expect(page.locator(HINT_BADGES)).toHaveCount(0)
  })

  test('modifier+digit while hints are shown navigates to the hinted agent', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'CmdHint Agent Nav'))
    await pinAgentsFirst(request, [agent])
    await loadApp()

    await holdModifierForHints(page)
    try {
      const badge = getAgentItem(page, agent).locator(HINT_BADGES)
      await expect(badge).toBeVisible()
      const digit = hintNumber(await badge.getAttribute('data-testid'))

      await page.keyboard.press(String(digit))
      await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 15000 })
      await expect(getAgentItem(page, agent)).toHaveAttribute('data-active', 'true')
    } finally {
      await page.keyboard.up('ControlOrMeta')
    }
  })

  test('expanded agent sessions get the following hint numbers and digit navigation opens the session', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'CmdHint Sessions'))
    await createSession(request, agent, 'cmd hint session one')
    await createSession(request, agent, 'cmd hint session two')
    await pinAgentsFirst(request, [agent])
    await loadApp()

    await agentPage.expandAgent(agent.name)
    const sessionRows = agentPage.getAgentLi(agent.name).locator('[data-testid^="session-item-"]')
    await expect(sessionRows).toHaveCount(2)

    await holdModifierForHints(page)
    try {
      const agentBadge = getAgentItem(page, agent).locator(HINT_BADGES)
      await expect(agentBadge).toBeVisible()
      const agentDigit = hintNumber(await agentBadge.getAttribute('data-testid'))

      // The expanded agent's visible sub-rows take the numbers directly after
      // the agent row, in row order.
      const sessionBadges = sessionRows.locator(HINT_BADGES)
      await expect(sessionBadges).toHaveCount(2)
      const sessionDigits = (await sessionBadges.evaluateAll(
        (els) => els.map((el) => el.getAttribute('data-testid')),
      )).map(hintNumber)
      expect(sessionDigits).toEqual([agentDigit + 1, agentDigit + 2])

      const firstSessionId = (await sessionRows.first().getAttribute('data-testid'))!
        .replace('session-item-', '')

      await page.keyboard.press(String(agentDigit + 1))
      await expect(page).toHaveURL(new RegExp(`/sessions/${firstSessionId}$`), { timeout: 15000 })
      await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    } finally {
      await page.keyboard.up('ControlOrMeta')
    }
  })
})
