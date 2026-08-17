import { Page, expect } from '@playwright/test'

/**
 * Page object for agent access management (ACL) — the Share popover on the
 * agent home header. Formerly the "Access" tab in the agent settings dialog.
 */
export class AccessPage {
  constructor(private page: Page) {}

  /** Select the agent in the sidebar and open the Share popover from its header */
  async openAccessTab(agentName: string) {
    // Click the agent in the sidebar to land on its home page (find by name
    // text, slug has random suffix)
    await this.page.locator(`[data-testid^="agent-item-"]`, { hasText: agentName }).click()
    // Open the Share popover
    await this.page.locator('[data-testid="agent-share-button"]').click()
    await expect(this.page.locator('[data-testid="agent-share-popover"]')).toBeVisible()
  }

  /** Invite a user by searching and selecting them */
  async inviteUser(searchQuery: string, role: 'viewer' | 'user' | 'owner' = 'user') {
    // Search for user (the invite input is always visible in the popover)
    await this.page.locator('[data-testid="invite-search-input"]').fill(searchQuery)

    // Wait for search results and click the first one
    const firstResult = this.page.locator('[data-testid^="invite-user-result-"]').first()
    await expect(firstResult).toBeVisible()
    await firstResult.click()

    // Select role
    await this.page.locator('[data-testid="invite-role-select"]').click()
    await this.page.getByRole('option', { name: role === 'viewer' ? 'Viewer' : role === 'user' ? 'User' : 'Owner' }).click()

    // Click Add
    await this.page.locator('[data-testid="invite-add-button"]').click()

    // The form resets to the empty search input on success; the new entry
    // appearing in the list is the reliable success signal.
    await expect(this.page.locator('[data-testid^="access-entry-"]').filter({ hasText: searchQuery })).toBeVisible()
  }

  /** Change a user's role in the access list */
  async changeRole(userId: string, newRole: 'viewer' | 'user' | 'owner') {
    await this.page.locator(`[data-testid="access-role-${userId}"]`).click()
    const label = newRole === 'viewer' ? 'Viewer' : newRole === 'user' ? 'User' : 'Owner'
    await this.page.getByRole('option', { name: label }).click()
    await expect(this.page.locator(`[data-testid="access-role-${userId}"]`)).toContainText(label)
  }

  /** Remove a user via the Remove item inside their role dropdown */
  async removeUser(userId: string) {
    await this.page.locator(`[data-testid="access-role-${userId}"]`).click()
    await this.page.locator(`[data-testid="access-remove-${userId}"]`).click()
    await expect(this.page.locator(`[data-testid="access-entry-${userId}"]`)).not.toBeVisible()
  }

  /** Verify the no-permission overlay is shown (agent settings dialog) */
  async expectNoPermissionOverlay() {
    await expect(this.page.locator('[data-testid="agent-settings-no-permission"]')).toBeVisible()
  }

  /** Close the Share popover */
  async closeSettings() {
    await this.page.keyboard.press('Escape')
    await expect(this.page.locator('[data-testid="agent-share-popover"]')).not.toBeVisible()
  }
}
