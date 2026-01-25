import { Page, expect } from '@playwright/test'

/**
 * Page object for the main application layout
 */
export class AppPage {
  constructor(private page: Page) {}

  /**
   * Navigate to the app's root URL
   */
  async goto() {
    await this.page.goto('/')
  }

  /**
   * Wait for the sidebar to be visible (indicates app is loaded)
   */
  async waitForAppLoaded() {
    await expect(this.page.locator('[data-testid="app-sidebar"]')).toBeVisible()
  }

  /**
   * Wait for agents list to finish loading (no loading skeletons)
   */
  async waitForAgentsLoaded() {
    // Wait for sidebar to be visible first
    await this.waitForAppLoaded()
    // Wait a moment for any loading states to resolve
    await this.page.waitForTimeout(500)
  }

  /**
   * Get the sidebar element
   */
  getSidebar() {
    return this.page.locator('[data-testid="app-sidebar"]')
  }

  /**
   * Get the main content area
   */
  getMainContent() {
    return this.page.locator('[data-testid="main-content"]')
  }

  /**
   * Reload the page and wait for it to be ready
   */
  async reload() {
    await this.page.reload()
    await this.waitForAppLoaded()
  }
}
