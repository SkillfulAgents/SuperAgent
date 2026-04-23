import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Result } from 'axe-core'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.describe('Accessibility Audit', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('main app shell has no critical a11y violations', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    logViolations('App Shell', results.violations)
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([])
  })

  test('agent landing page has no critical a11y violations', async ({ page }) => {
    const agentName = `A11y Test Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    logViolations('Agent Landing', results.violations)
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([])

    await agentPage.deleteAgent()
  })

  test('global settings dialog has no critical a11y violations', async ({ page }) => {
    await page.locator('[data-testid="settings-button"]').click()
    await expect(page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    logViolations('Global Settings', results.violations)
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([])
  })

  test('agent settings dialog has no critical a11y violations', async ({ page }) => {
    const agentName = `A11y Settings Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    await page.locator('[data-testid="agent-settings-button"]').click()
    await expect(page.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    logViolations('Agent Settings', results.violations)
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([])

    await page.keyboard.press('Escape')
    await agentPage.deleteAgent()
  })

  test('new agent landing has no critical a11y violations', async ({ page }) => {
    await page.locator('[data-testid="create-agent-button"]').click()
    // The new flow lands directly on the AgentHome for a fresh Untitled agent.
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    logViolations('New Agent Landing', results.violations)
    expect(results.violations.filter(v => v.impact === 'critical')).toEqual([])
  })
})

function logViolations(pageName: string, violations: Result[]) {
  if (violations.length === 0) return

  console.log(`\n=== ${pageName}: ${violations.length} a11y violations ===\n`)
  for (const v of violations) {
    console.log(`[${v.impact?.toUpperCase()}] ${v.id}: ${v.description}`)
    console.log(`  Help: ${v.helpUrl}`)
    for (const node of v.nodes.slice(0, 3)) {
      console.log(`  Element: ${node.target.join(' > ')}`)
      console.log(`  HTML: ${node.html.slice(0, 200)}`)
    }
    console.log()
  }
}
