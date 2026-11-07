import { slideToConfirm } from '../helpers/slide-to-confirm'
import { Page, expect } from '@playwright/test'
import { createAgent as createAgentViaApi, gotoAgentHome, type TestAgent } from '../helpers/agents'

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
   * Open the sidebar's New Agent menu and pick one of its ways in.
   */
  async openNewAgentMenu(option: 'from-scratch' | 'browse-templates' | 'import') {
    await this.page.locator('[data-testid="new-agent-button"]').click()
    await this.page.locator(`[data-testid="new-agent-${option}"]`).click()
  }

  /**
   * New Agent → From Scratch, and wait for the create page's first step, the
   * name and avatar. Nothing is created until the add-ons step's Create.
   */
  async clickCreateAgent() {
    await this.openNewAgentMenu('from-scratch')
    await expect(this.page.locator('[data-testid="new-agent-page"]')).toBeVisible({ timeout: 10000 })
    await expect(this.page.locator('[data-testid="agent-identity-name"]')).toBeVisible()
  }

  /**
   * On the create page's name step: name the teammate (keeping the drawn
   * avatar) and continue to the describe step, with its prompt, templates and
   * Import tile.
   */
  async nameNewAgent(name: string) {
    await this.page.locator('[data-testid="agent-identity-name"]').fill(name)
    await this.page.locator('[data-testid="agent-identity-continue"]').click()
    await expect(this.page.locator('[data-testid="create-agent-prompt"]')).toBeVisible()
  }

  /**
   * Create an agent the way a user does: "New Agent" opens the create page,
   * named here after the prompt; the prompt, then Create Agent on the add-ons
   * step (left as they start), creates the agent and its first session. Then
   * click the agent breadcrumb so the caller lands on agent-home (where
   * agent-settings-button lives) rather than that session.
   */
  async createAgent(prompt: string, options: CreateAgentOptions = {}) {
    const { waitForSidebarName = true } = options

    await this.clickCreateAgent()
    await this.nameNewAgent(prompt)

    await this.page.locator('[data-testid="create-agent-prompt"]').fill(prompt)
    await this.page.locator('[data-testid="create-agent-continue"]').click()
    await expect(this.page.locator('[data-testid="agent-addons-step"]')).toBeVisible()
    await this.page.locator('[data-testid="create-agent-finish"]').click()

    // Submit creates the agent and a session, then navigates to the session.
    // Wait for the message list so we know navigation landed, then go back to
    // agent-home.
    await expect(this.page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    await this.page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(this.page.locator('[data-testid="agent-settings-button"]')).toBeVisible()

    // Downstream tests that re-select agents by name need the sidebar row to
    // be indexed, but session-only tests can avoid coupling to the sidebar
    // refresh.
    await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(prompt, { timeout: 15000 })
    if (waitForSidebarName) {
      await this.waitForAgentInSidebar(prompt)
    }
  }

  /**
   * Land on the home of a fresh agent with no sessions — the empty state with
   * the creation aids (voice card, import) and the home composer. Made through
   * the API: the UI's create page always starts a session or installs a
   * template, so it never leaves an agent this empty.
   */
  async openEmptyAgent(name = 'Untitled'): Promise<TestAgent> {
    const agent = await createAgentViaApi(this.page.request, name)
    await gotoAgentHome(this.page, agent)
    return agent
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
   * The chevron renders once the agent has something to expand. A session
   * created through the API a moment ago is listed by the sessions endpoint
   * as soon as its metadata is written but counted by the agents endpoint
   * only once its transcript lands, so the chevron can appear a beat after
   * the row does: wait for it rather than probe once. No-op if the agent is
   * already expanded.
   */
  async expandAgent(name: string) {
    const li = this.getAgentLi(name)
    const chevron = li.locator('button[aria-label="Expand"], button[aria-label="Collapse"]').first()
    await chevron.waitFor({ state: 'visible', timeout: 15000 })
    if ((await chevron.getAttribute('aria-label')) === 'Expand') {
      await chevron.click()
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
   * Open the agent menu (the three-dot on the agent header). It is the same
   * menu a right-click on the sidebar row opens.
   */
  async openAgentMenu() {
    await this.page.locator('[data-testid="agent-settings-button"]').click()
    await expect(this.page.locator('[data-testid="agent-context-menu"]')).toBeVisible()
  }

  /**
   * Delete the current agent via the agent menu
   */
  async deleteAgent() {
    await this.openAgentMenu()

    // Click delete item
    await this.page.locator('[data-testid="delete-agent-item"]').click()

    // Confirm deletion by sliding the handle across its track
    await slideToConfirm(this.page, 'confirm-delete-agent-button')

    // Wait for the confirm dialog to close (with longer timeout for deletion to complete)
    await expect(this.page.locator('[data-testid="confirm-delete-agent-button"]')).not.toBeVisible({ timeout: 10000 })
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

export function getCurrentAgentSlug(page: Page) {
  const match = page.url().match(/\/agents\/([^/?#]+)/)
  expect(match).toBeTruthy()
  return match![1]
}
