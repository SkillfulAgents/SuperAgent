import { Page, expect } from '@playwright/test'

export type AgentActivityStatus = 'sleeping' | 'idle' | 'working' | 'awaiting_input'

type CreateAgentOptions = {
  waitForSidebarName?: boolean
}

/**
 * Page object for agent-related operations
 */
export class AgentPage {
  constructor(private page: Page) {}

  /**
   * Click the "Create Agent" button in the sidebar
   */
  async clickCreateAgent() {
    await this.page.locator('[data-testid="new-agent-button"]').click()
  }

  /**
   * Click "New Agent" — this immediately creates an Untitled agent and lands on
   * its AgentHome. Type the prompt, submit via the Create Agent button, then
   * click the agent breadcrumb so the caller lands on agent-home (where
   * agent-settings-button lives) rather than the first session view.
   */
  async createAgent(prompt: string, options: CreateAgentOptions = {}) {
    const { waitForSidebarName = true } = options

    await this.clickCreateAgent()

    // Wait until we've actually landed on the fresh Untitled agent's AgentHome
    // (the breadcrumb shows "Untitled") before filling — otherwise fills can
    // race the A→B remount and end up on the outgoing agent's textbox.
    await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })
    await expect(this.page.locator('[data-testid="home-message-input"]')).toBeVisible()

    await this.page.locator('[data-testid="home-message-input"]').fill(prompt)
    await this.page.locator('[data-testid="home-send-button"]').click()

    // First submit creates a session and navigates to it. Wait for the session
    // message list so we know navigation landed, then go back to agent-home.
    await expect(this.page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    await this.page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(this.page.locator('[data-testid="agent-settings-button"]')).toBeVisible()

    // The agent is created as "Untitled" then renamed async after session
    // creation. Downstream tests that re-select agents by name need the
    // sidebar row to be indexed, but session-only tests can avoid coupling to
    // the sidebar refresh.
    await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(prompt, { timeout: 15000 })
    if (waitForSidebarName) {
      await this.waitForAgentInSidebar(prompt)
    }
  }

  private async waitForAgentInSidebar(name: string) {
    const row = this.getAgentItem(name)

    try {
      await expect(row).toBeVisible({ timeout: 5000 })
      return
    } catch {
      // The agent detail can observe the async rename before the sidebar list
      // has refreshed under heavier parallel load. Reloading the current agent
      // route forces a fresh /api/agents read without changing the selected
      // agent.
      await Promise.all([
        this.page
          .waitForResponse((response) => response.url().includes('/api/agents') && response.status() === 200, {
            timeout: 15000,
          })
          .catch(() => undefined),
        this.page.reload(),
      ])
      await expect(this.page.locator('[data-testid="new-agent-button"]')).toBeVisible({ timeout: 15000 })
      await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(name, { timeout: 15000 })
      await expect(row).toBeVisible({ timeout: 15000 })
    }
  }

  /**
   * Get the slug from an agent name (lowercase, hyphenated)
   */
  getSlugFromName(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-')
  }

  /**
   * Select an agent by clicking on it in the sidebar
   */
  async selectAgent(name: string) {
    // Use the getAgentItem method which handles fallback selectors
    await this.getAgentItem(name).click()
  }

  /**
   * Get the SidebarMenuItem `<li>` that contains the agent row — useful for
   * scoping subsequent locators (chevron, session sub-items) to that agent.
   * Resolves via the row's testid first, falling back to text match because
   * agents are created as "Untitled" + random slug; the display name is
   * renamed asynchronously but the slug never changes.
   */
  getAgentLi(name: string) {
    return this.getAgentItem(name).locator('xpath=ancestor::li[1]')
  }

  /**
   * Expand the agent's submenu (sessions / dashboards / etc.) by clicking its
   * chevron in the sidebar. The post-glow-up sidebar uses a "click split"
   * where the row click only selects and the chevron alone toggles
   * expansion — so callers that need to reach session sub-items must
   * expand explicitly.
   *
   * No-op if the agent is already expanded.
   */
  async expandAgent(name: string) {
    const li = this.getAgentLi(name)
    const expandChevron = li.locator('button[aria-label="Expand"]').first()
    if (await expandChevron.isVisible({ timeout: 500 }).catch(() => false)) {
      await expandChevron.click()
    }
  }

  /**
   * Check if an agent exists in the sidebar
   */
  async agentExists(name: string): Promise<boolean> {
    const slug = this.getSlugFromName(name)
    const agent = this.page.locator(`[data-testid="agent-item-${slug}"]`)
    return await agent.isVisible()
  }

  /**
   * Get the agent item element
   */
  getAgentItem(name: string) {
    return this.page.locator('[data-testid^="agent-item-"]', { hasText: name }).first()
  }

  /**
   * Open the agent settings dialog
   */
  async openSettings() {
    await this.page.locator('[data-testid="agent-settings-button"]').click()
    await expect(this.page.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()
  }

  /**
   * Delete the current agent via settings
   */
  async deleteAgent() {
    await this.openSettings()

    // Click delete button
    await this.page.locator('[data-testid="delete-agent-button"]').click()

    // Confirm deletion - use a longer timeout since deletion may take time
    await this.page.locator('[data-testid="confirm-button"]').click()

    // Wait for settings dialog to close (with longer timeout for deletion to complete)
    await expect(this.page.locator('[data-testid="agent-settings-dialog"]')).not.toBeVisible({ timeout: 10000 })
  }

  /**
   * Get the current agent status (from the main content header, not sidebar)
   */
  getStatus() {
    // Use the status in the main content area, not the sidebar
    return this.page.locator('[data-testid="main-content"] [data-testid="agent-status"]').first()
  }

  /**
   * Assert the agent status matches expected value
   */
  async expectStatus(status: AgentActivityStatus) {
    const statusElement = this.getStatus()
    await expect(statusElement).toHaveAttribute('data-status', status)
  }

  /**
   * Wait for status to change to expected value
   */
  async waitForStatus(status: AgentActivityStatus, timeout = 10000) {
    const statusElement = this.getStatus()
    await expect(statusElement).toHaveAttribute('data-status', status, { timeout })
  }
}
