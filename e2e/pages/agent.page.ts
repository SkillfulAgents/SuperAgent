import { Page, expect } from '@playwright/test'

export type AgentActivityStatus = 'sleeping' | 'idle' | 'working' | 'awaiting_input'
export interface CreatedAgent {
  name: string
  slug: string
}

interface ApiAgentSummary {
  name?: string
  slug?: string
}

interface SidebarWaitOptions {
  timeout?: number
  reloadOnMiss?: boolean
}

function fallbackNameFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 50) || 'New Agent'
}

/**
 * Page object for agent-related operations
 */
export class AgentPage {
  private agentSlugsByName = new Map<string, string>()

  constructor(private page: Page) {}

  rememberAgent(agent: CreatedAgent) {
    this.agentSlugsByName.set(agent.name, agent.slug)
  }

  private async apiUrl(pathname: string) {
    const origin = await this.page.evaluate(() => window.location.origin)
    return new URL(pathname, origin).toString()
  }

  private async waitForAgentSlugByName(name: string, timeout = 15000): Promise<string> {
    const knownSlug = this.agentSlugsByName.get(name)
    if (knownSlug) return knownSlug

    let lastAgents: ApiAgentSummary[] = []
    let foundSlug: string | undefined

    await expect.poll(async () => {
      const response = await this.page.request.get(await this.apiUrl('/api/agents'))
      if (response.ok()) {
        lastAgents = await response.json() as ApiAgentSummary[]
        const agent = lastAgents.find((candidate) => candidate.name === name && candidate.slug)
        if (agent?.slug) {
          foundSlug = agent.slug
        }
      }
      return foundSlug ?? null
    }, { timeout }).not.toBeNull()

    if (!foundSlug) {
      throw new Error(`Agent "${name}" not found in API. Agents seen: ${JSON.stringify(lastAgents)}`)
    }
    this.agentSlugsByName.set(name, foundSlug)
    return foundSlug
  }

  async getAgentSlug(name: string, timeout = 15000): Promise<string> {
    return this.waitForAgentSlugByName(name, timeout)
  }

  private async revealAgentItem(slug: string, timeout: number) {
    const item = this.page.locator(`[data-testid="agent-item-${slug}"]`)
    await expect(item).toHaveCount(1, { timeout })
    await item.scrollIntoViewIfNeeded({ timeout })
    await expect(item).toBeVisible({ timeout })
    return item
  }

  async waitForAgentInSidebar(name: string, options: SidebarWaitOptions = {}) {
    const timeout = options.timeout ?? 15000
    const reloadOnMiss = options.reloadOnMiss ?? true
    const slug = await this.waitForAgentSlugByName(name, timeout)

    try {
      return await this.revealAgentItem(slug, timeout)
    } catch (error) {
      if (!reloadOnMiss) throw error
    }

    await this.page.reload()
    await expect(this.page.locator('[data-testid="new-agent-button"]')).toBeVisible({ timeout })

    return this.revealAgentItem(slug, timeout)
  }

  async waitForAgentDeletedFromApi(name: string, timeout = 15000) {
    let lastAgents: ApiAgentSummary[] = []

    await expect.poll(async () => {
      const response = await this.page.request.get(await this.apiUrl('/api/agents'))
      if (response.ok()) {
        lastAgents = await response.json() as ApiAgentSummary[]
        return !lastAgents.some((agent) => agent.name === name)
      }
      return false
    }, { timeout }).toBe(true)

    if (lastAgents.some((agent) => agent.name === name)) {
      throw new Error(`Agent "${name}" was still present in API after deletion`)
    }
    this.agentSlugsByName.delete(name)
  }

  async deleteAgentByNameFromApi(name: string) {
    const slug = await this.waitForAgentSlugByName(name)
    const response = await this.page.request.delete(await this.apiUrl(`/api/agents/${slug}`))
    expect(response.ok()).toBeTruthy()
    this.agentSlugsByName.delete(name)
  }

  /**
   * Click the "Create Agent" button in the sidebar
   */
  async clickCreateAgent() {
    const button = this.page.locator('[data-testid="new-agent-button"]')
    await expect(button).toBeEnabled({ timeout: 10000 })
    await button.click()
  }

  private waitForCreateAgentResponse(timeout = 5000) {
    return this.page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST' && url.pathname === '/api/agents'
    }, { timeout }).catch(() => null)
  }

  private async isOnUntitledAgentHome() {
    return this.page.locator('[data-testid="agent-breadcrumb"]')
      .evaluate((el) => el.textContent?.trim() === 'Untitled')
      .catch(() => false)
  }

  private async createUntitledAgentViaUi(): Promise<string | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sidebarResponsePromise = this.waitForCreateAgentResponse()
      await this.clickCreateAgent()
      const sidebarResponse = await sidebarResponsePromise
      if (sidebarResponse) {
        expect(sidebarResponse.ok()).toBeTruthy()
        const agent = (await sidebarResponse.json().catch(() => null)) as { slug?: string } | null
        return agent?.slug?.trim()
      }
      if (await this.isOnUntitledAgentHome()) return undefined

      const homeNewAgentButton = this.page.locator('main').getByRole('button', { name: 'New Agent' }).first()
      if (await homeNewAgentButton.isVisible({ timeout: 500 }).catch(() => false)) {
        const homeResponsePromise = this.waitForCreateAgentResponse()
        await homeNewAgentButton.click()
        const homeResponse = await homeResponsePromise
        if (homeResponse) {
          expect(homeResponse.ok()).toBeTruthy()
          const agent = (await homeResponse.json().catch(() => null)) as { slug?: string } | null
          return agent?.slug?.trim()
        }
        if (await this.isOnUntitledAgentHome()) return undefined
      }
    }

    throw new Error('Create Agent did not navigate to an Untitled agent or return a create response')
  }

  /**
   * Click "New Agent" — this immediately creates an Untitled agent and lands on
   * its AgentHome. Type the prompt, submit via the Create Agent button, then
   * click the agent breadcrumb so the caller lands on agent-home (where
   * agent-settings-button lives) rather than the first session view.
   */
  async createAgent(prompt: string): Promise<CreatedAgent> {
    const expectedFallbackName = fallbackNameFromPrompt(prompt)

    const untitledSlug = await this.createUntitledAgentViaUi()

    // Wait until we've actually landed on the fresh Untitled agent's AgentHome
    // (the breadcrumb shows "Untitled") before filling — otherwise fills can
    // race the A→B remount and end up on the outgoing agent's textbox.
    try {
      await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })
    } catch (error) {
      if (!untitledSlug) throw error
      await this.page.locator(`[data-testid="agent-item-${untitledSlug}"]`).click()
      await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })
    }
    await expect(this.page.locator('[data-testid="home-message-input"]')).toBeVisible()

    await this.page.locator('[data-testid="home-message-input"]').fill(prompt)
    const renameResponsePromise = this.page.waitForResponse((response) => {
      return response.request().method() === 'PUT'
        && /\/api\/agents\/[^/?#]+(?:[?#]|$)/.test(response.url())
    }, { timeout: 30000 })
    await this.page.locator('[data-testid="home-send-button"]').click()

    // First submit creates a session and navigates to it. Wait for the session
    // message list so we know navigation landed, then go back to agent-home.
    await expect(this.page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
    const renameResponse = await renameResponsePromise
    expect(renameResponse.ok()).toBeTruthy()
    const renamedAgent = (await renameResponse.json().catch(() => null)) as { name?: string; slug?: string } | null
    const createdAgentName = renamedAgent?.name?.trim() || expectedFallbackName
    const createdAgentSlug = renamedAgent?.slug?.trim()
    if (!createdAgentSlug) {
      throw new Error(`Created agent ${createdAgentName} did not include a slug in the update response`)
    }
    this.agentSlugsByName.set(createdAgentName, createdAgentSlug)

    await this.page.locator('[data-testid="agent-breadcrumb"]').click()
    await expect(this.page.locator('[data-testid="agent-settings-button"]')).toBeVisible()

    // The agent is created as "Untitled" then renamed async after session
    // creation. The main view is the creation contract; sidebar rows can lag
    // under high parallelism and are asserted by sidebar-specific tests.
    await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(createdAgentName, { timeout: 15000 })

    return { name: createdAgentName, slug: createdAgentSlug }
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
    const item = await this.waitForAgentInSidebar(name)
    await item.click()
    await expect(this.page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(name, { timeout: 15000 })
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
    const item = await this.waitForAgentInSidebar(name)
    const li = item.locator('xpath=ancestor::li[1]')
    const expandChevron = li.locator('button[aria-label="Expand"]').first()
    if (await expandChevron.isVisible({ timeout: 500 }).catch(() => false)) {
      await expandChevron.click()
    }
  }

  /**
   * Check if an agent exists in the sidebar
   */
  async agentExists(name: string): Promise<boolean> {
    const slug = this.agentSlugsByName.get(name) ?? this.getSlugFromName(name)
    const agent = this.page.locator(`[data-testid="agent-item-${slug}"]`)
    return await agent.isVisible()
  }

  /**
   * Get the agent item element
   */
  getAgentItem(name: string) {
    const slug = this.agentSlugsByName.get(name)
    if (slug) {
      return this.page.locator(`[data-testid="agent-item-${slug}"]`)
    }
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
