import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

/**
 * Regression guard for the new-agent intro ("morph") animation.
 *
 * Clicking "New Agent" mints an Untitled agent, stamps the morph tag
 * (`justCreatedSlug`) into NavTransientContext, and navigates to the fresh
 * AgentHome, which plays a one-shot staggered slide-in: a brief "Creating"
 * overlay, then the sections fan in. The AgentHome root reflects this via
 * `data-intro` (absent → 'pending' → 'playing').
 *
 * The tag is React state in a provider mounted above the router; the producer
 * must commit it BEFORE `navigate`, because the router renders AgentHome
 * synchronously within the same tick and AgentHome reads the tag once in a
 * mount-time initializer. A prior change made AgentHome resolve from cache and
 * mount during that synchronous navigate — so without a synchronous commit it
 * captured the pre-set `null`, the intro state stayed absent, and nothing
 * animated. This test pins that the intro actually fires end-to-end.
 */
test.describe('New-agent intro animation', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('plays the staggered intro on a freshly created agent', async ({ page }) => {
    await agentPage.clickCreateAgent()

    // Landed on the fresh Untitled agent's AgentHome.
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })

    // The morph fired: AgentHome captured the tag at mount and entered the intro.
    // Absent `data-intro`, the tag read as null and nothing animated — the bug.
    const home = page.locator('[data-testid="agent-home"]')
    await expect(home).toHaveAttribute('data-intro', /pending|playing/)

    // The "Initializing" overlay covers the page during the paused first beat.
    await expect(page.getByText('Creating', { exact: true })).toBeVisible()

    // The 1s gate fires and the steps animate: state advances to 'playing' and
    // the overlay clears. Proves the animation actually runs, not just mounts.
    await expect(home).toHaveAttribute('data-intro', 'playing', { timeout: 5000 })
    await expect(page.getByText('Creating', { exact: true })).toHaveCount(0)
  })

  test('does not replay the one-shot when re-opening the same agent', async ({ page }) => {
    await agentPage.clickCreateAgent()
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })
    await expect(page.locator('[data-testid="agent-home"]')).toHaveAttribute('data-intro', /pending|playing/)

    // Capture the agent's in-app route, leave to Home, then return via the
    // sidebar (no hard reload) — the morph tag was consumed on first mount, so
    // the intro must NOT play again.
    let agentPath = ''
    try {
      agentPath = new URL(page.url()).pathname
    } catch {
      agentPath = ''
    }
    const agentId = agentPath.split('-').pop() ?? ''
    expect(agentId).not.toBe('')

    await page.locator('[data-testid="home-button"]').click()
    await expect(page.locator('[data-testid="new-agent-button"]')).toBeVisible()

    await page.locator(`[data-testid="agent-item-${agentId}"]`).click()

    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })
    await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="agent-home"]')).not.toHaveAttribute('data-intro', /pending|playing/)
  })
})
