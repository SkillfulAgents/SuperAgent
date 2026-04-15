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
   * Wait for the app to be loaded (sidebar visible or wizard visible)
   */
  async waitForAppLoaded() {
    await expect(
      this.page.locator('[data-testid="app-sidebar"], [data-testid="wizard-container"]').first()
    ).toBeVisible()
  }

  /**
   * Dismiss the getting started wizard if it's open.
   * Navigates through all steps using Next/Skip to close it.
   * Requires E2E mock mode (mock API key configured, runtime available).
   */
  async dismissWizardIfVisible() {
    const wizard = this.page.locator('[data-testid="wizard-container"]')
    if (await wizard.isVisible({ timeout: 1000 }).catch(() => false)) {
      const stepContent = this.page.locator('[data-testid="wizard-step-content"]')
      // Use the manual path so generic app tests can dismiss the wizard
      // without relying on platform auth state.
      await this.page.locator('[data-testid="wizard-manual-setup"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '0')

      // LLM -> Browser
      await this.page.locator('[data-testid="wizard-next"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '1')

      // Browser -> Composio
      await this.page.locator('[data-testid="wizard-next"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '2')

      // Composio -> Runtime
      await this.page.locator('[data-testid="wizard-skip"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '3')

      // Runtime -> Privacy
      await this.page.locator('[data-testid="wizard-next"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '4')

      // Privacy -> Agent
      await this.page.locator('[data-testid="wizard-next"]').click()
      await expect(stepContent).toHaveAttribute('data-step', '5')

      // Skip on Agent step finishes the wizard
      await this.page.locator('[data-testid="wizard-skip"]').click()
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
    // Wait for the app to be interactive (create agent button visible).
    // If the wizard appeared after our check (race with parallel tests),
    // try dismissing it once more.
    const createBtn = this.page.locator('[data-testid="create-agent-button"]')
    try {
      await expect(createBtn).toBeVisible({ timeout: 3000 })
    } catch {
      await this.dismissWizardIfVisible()
      await expect(createBtn).toBeVisible()
    }
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
    // Wait for both the page load and the agents API response to complete
    await Promise.all([
      this.page.waitForResponse((resp) => resp.url().includes('/api/agents') && resp.status() === 200),
      this.page.reload(),
    ])
    await this.waitForAgentsLoaded()
  }
}
