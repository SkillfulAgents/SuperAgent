import { Page, expect } from '@playwright/test'

/**
 * Page object for global settings dialog interactions
 */
export class SettingsPage {
  constructor(private page: Page) {}

  /** Open settings via sidebar footer button */
  async open() {
    await this.page.locator('[data-testid="settings-button"]').click()
    await expect(this.page.locator('[data-testid="global-settings-dialog"]')).toBeVisible()
  }

  /** Navigate to a settings tab */
  async navigateToTab(tabId: string) {
    await this.page.locator(`[data-testid="settings-nav-${tabId}"]`).click()
  }

  /** Assert a settings tab is visible in the nav */
  async expectTabVisible(tabId: string) {
    await expect(this.page.locator(`[data-testid="settings-nav-${tabId}"]`)).toBeVisible()
  }

  /** Assert a settings tab is NOT visible in the nav */
  async expectTabNotVisible(tabId: string) {
    await expect(this.page.locator(`[data-testid="settings-nav-${tabId}"]`)).not.toBeVisible()
  }

  /** Verify a user appears in the Users tab list */
  async expectUserInList(email: string) {
    await expect(this.page.locator(`[data-testid="user-row-${email}"]`)).toBeVisible()
  }

  /** Close the settings dialog */
  async close() {
    await this.page.keyboard.press('Escape')
    await expect(this.page.locator('[data-testid="global-settings-dialog"]')).not.toBeVisible()
  }
}
