import { Page, expect } from '@playwright/test'

/**
 * Page object for the Getting Started Wizard
 *
 * Manual flow steps (0-indexed):
 *   0: LLM  |  1: Browser  |  2: Composio  |  3: Runtime  |  4: Privacy  |  5: Agent
 *
 * Skippable steps: Composio (2), Agent (5)
 * Non-skippable steps with gating: LLM (needs key), Browser (default ok), Runtime (needs available runner)
 */
export class WizardPage {
  constructor(private page: Page) {}

  /** Get the wizard container locator */
  getDialog() {
    return this.page.locator('[data-testid="wizard-container"]')
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

  /** Choose the manual setup path from the welcome screen */
  async chooseManualSetup() {
    await this.page.locator('[data-testid="wizard-manual-setup"]').click()
  }

  /** Choose the platform setup path from the welcome screen */
  async choosePlatformSetup() {
    await this.page.locator('[data-testid="wizard-platform-login"]').click()
  }

  /** Click the Back button */
  async clickBack() {
    await this.page.locator('[data-testid="wizard-back"]').click()
  }

  /** Click the Skip button (available on optional steps: Composio, Agent) */
  async clickSkip() {
    await this.page.locator('[data-testid="wizard-skip"]').click()
  }

  /** Check if the Back button is disabled */
  async expectBackDisabled() {
    await expect(this.page.locator('[data-testid="wizard-back"]')).toBeDisabled()
  }

  /** Check if the Back button is enabled */
  async expectBackEnabled() {
    await expect(this.page.locator('[data-testid="wizard-back"]')).toBeEnabled()
  }

  /**
   * Navigate through the full manual wizard flow to completion.
   * Requires a mock API key to be configured (LLM step gating)
   * and a runtime to be available (Runtime step gating).
   *
   * Steps: LLM(Next) -> Browser(Next) -> Composio(Skip) -> Runtime(Next) -> Privacy(Next) -> Agent(Skip=Finish)
   */
  async dismissManualFlow() {
    await this.chooseManualSetup()
    await this.expectStep(0)
    await this.clickNext()    // LLM -> Browser
    await this.expectStep(1)
    await this.clickNext()    // Browser -> Composio
    await this.expectStep(2)
    await this.clickSkip()    // Composio -> Runtime
    await this.expectStep(3)
    await this.clickNext()    // Runtime -> Privacy
    await this.expectStep(4)
    await this.clickNext()    // Privacy -> Agent
    await this.expectStep(5)
    await this.clickSkip()    // Agent (skip = finish)
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
