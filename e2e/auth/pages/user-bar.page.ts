import { Page, expect } from '@playwright/test'

/**
 * Page object for sidebar user footer (user name, sign out)
 */
export class UserBarPage {
  constructor(private page: Page) {}

  /** Sign out via user menu */
  async signOut() {
    await this.page.locator('[data-testid="user-menu-trigger"]').click()
    await this.page.locator('[data-testid="sign-out-button"]').click()
  }

  /** Verify the displayed user name */
  async expectUserName(name: string) {
    await expect(this.page.locator('[data-testid="user-menu-trigger"]')).toContainText(name)
  }
}
