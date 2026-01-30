import { Page, expect } from '@playwright/test'

/**
 * Page object for the Getting Started Wizard
 */
export class WizardPage {
  constructor(private page: Page) {}

  /** Get the wizard dialog locator */
  getDialog() {
    return this.page.locator('[data-testid="wizard-dialog"]')
  }

  /** Get the step content container */
  getStepContent() {
    return this.page.locator('[data-testid="wizard-step-content"]')
  }

  /** Assert the wizard is visible */
  async expectVisible() {
    await expect(this.getDialog()).toBeVisible()
  }

  /** Assert the wizard is not visible */
  async expectNotVisible() {
    await expect(this.getDialog()).not.toBeVisible()
  }

  /** Assert the current step number (0-indexed) */
  async expectStep(step: number) {
    await expect(this.getStepContent()).toHaveAttribute('data-step', String(step))
  }

  /** Click the Next button */
  async clickNext() {
    await this.page.locator('[data-testid="wizard-next"]').click()
  }

  /** Click the Back button */
  async clickBack() {
    await this.page.locator('[data-testid="wizard-back"]').click()
  }

  /** Click the Skip button (available on optional steps) */
  async clickSkip() {
    await this.page.locator('[data-testid="wizard-skip"]').click()
  }

  /** Click the Finish button (available on the last step) */
  async clickFinish() {
    await this.page.locator('[data-testid="wizard-finish"]').click()
  }

  /** Check if the Back button is disabled */
  async expectBackDisabled() {
    await expect(this.page.locator('[data-testid="wizard-back"]')).toBeDisabled()
  }

  /** Check if the Back button is enabled */
  async expectBackEnabled() {
    await expect(this.page.locator('[data-testid="wizard-back"]')).toBeEnabled()
  }

  /** Fill in the agent name on the Create Agent step */
  async fillAgentName(name: string) {
    await this.page.locator('[data-testid="wizard-agent-name-input"]').fill(name)
  }

  /** Click the Create Agent button on the last step */
  async clickCreateAgent() {
    await this.page.locator('[data-testid="wizard-create-agent"]').click()
  }

  /**
   * Trigger the wizard via the Settings > Re-run Wizard button.
   * Assumes the app is loaded and no other dialogs are open.
   */
  async openViaSettings() {
    // Open settings dialog
    await this.page.locator('[data-testid="app-sidebar"]').getByText('Settings').click()
    // Click Re-run Wizard
    await this.page.locator('[data-testid="rerun-wizard-button"]').click()
    await this.expectVisible()
  }
}
