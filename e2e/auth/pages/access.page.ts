import { Page, expect } from '@playwright/test'

/**
 * Page object for agent access tab (ACL management)
 */
export class AccessPage {
  constructor(private page: Page) {}

  /** Open agent settings via context menu and navigate to Access tab */
  async openAccessTab(agentName: string) {
    // Right-click on the agent to open context menu (find by name text, slug has random suffix)
    await this.page.locator(`[data-testid^="agent-item-"]`, { hasText: agentName }).click({ button: 'right' })
    // Click Settings in context menu
    await this.page.locator('[data-testid="agent-settings-item"]').click()
    // Wait for agent settings dialog
    await expect(this.page.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()
    // Navigate to Access tab
    await this.page.locator('[data-testid="agent-settings-nav-access"]').click()
  }

  /** Invite a user by searching and selecting them */
  async inviteUser(searchQuery: string, role: 'viewer' | 'user' | 'owner' = 'user') {
    // Click Invite button
    await this.page.locator('[data-testid="invite-user-button"]').click()

    // Search for user
    await this.page.locator('[data-testid="invite-search-input"]').fill(searchQuery)

    // Wait for search results and click the first one
    const firstResult = this.page.locator('[data-testid^="invite-user-result-"]').first()
    await expect(firstResult).toBeVisible()
    await firstResult.click()

    // Select role
    await this.page.locator('[data-testid="invite-role-select"]').click()
    await this.page.locator(`[role="option"]:has-text("${role === 'viewer' ? 'Viewer' : role === 'user' ? 'User' : 'Owner'}")`).click()

    // Click Add
    await this.page.locator('[data-testid="invite-add-button"]').click()

    // Wait for invite form to close (indicates success)
    await expect(this.page.locator('[data-testid="invite-search-input"]')).not.toBeVisible()
  }

  /** Change a user's role in the access list */
  async changeRole(userId: string, newRole: 'viewer' | 'user' | 'owner') {
    await this.page.locator(`[data-testid="access-role-${userId}"]`).click()
    const label = newRole === 'viewer' ? 'Viewer' : newRole === 'user' ? 'User' : 'Owner'
    await this.page.locator(`[role="option"]:has-text("${label}")`).click()
  }

  /** Verify the no-permission overlay is shown */
  async expectNoPermissionOverlay() {
    await expect(this.page.locator('[data-testid="agent-settings-no-permission"]')).toBeVisible()
  }

  /** Close the agent settings dialog */
  async closeSettings() {
    await this.page.keyboard.press('Escape')
    await expect(this.page.locator('[data-testid="agent-settings-dialog"]')).not.toBeVisible()
  }
}
