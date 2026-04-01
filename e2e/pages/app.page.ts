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
   * Dismiss the getting started wizard if it's open.
   * Clicks through all steps using Next/Skip/Finish to close it.
   */
  async dismissWizardIfVisible() {
    const wizard = this.page.locator('[data-testid="wizard-dialog"]')
    if (await wizard.isVisible({ timeout: 1000 }).catch(() => false)) {
      const stepContent = this.page.locator('[data-testid="wizard-step-content"]')
      // The welcome screen now branches into Platform or manual setup.
      // Use the manual path so generic app tests can dismiss the wizard
      // without relying on platform auth state.
      await this.page.locator('[data-testid="wizard-manual-setup"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '0')

      // LLM -> Browser
      await this.page.locator('[data-testid="wizard-next"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '1')

      // Browser -> Composio
      await this.page.locator('[data-testid="wizard-skip"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '2')

      // Composio -> Runtime
      await this.page.locator('[data-testid="wizard-skip"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '3')

      // Runtime -> Agent
      await this.page.locator('[data-testid="wizard-skip"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '4')

      // Finish on the Agent step
      await this.page.locator('[data-testid="wizard-finish"]').click()
      await expect(wizard).not.toBeVisible()
    }
  }

  /**
   * Wait for agents list to finish loading (no loading skeletons)
   */
  async waitForAgentsLoaded() {
    // Wait for sidebar to be visible first
    await this.waitForAppLoaded()
    // Dismiss wizard if it auto-opened (safety net for clean test state)
    await this.dismissWizardIfVisible()
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
