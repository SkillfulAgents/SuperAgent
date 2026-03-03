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

  // ── Auth Tab helpers ─────────────────────────────────────────────────

  /** Open settings, navigate to Auth tab */
  async openAuthTab() {
    await this.open()
    await this.navigateToTab('auth')
  }

  /** Set the signup mode via the select dropdown */
  async setSignupMode(mode: 'open' | 'domain_restricted' | 'invitation_only' | 'closed') {
    await this.page.locator('[data-testid="auth-signup-mode"]').click()
    const labels: Record<string, string> = {
      open: 'Open',
      domain_restricted: 'Domain Restricted',
      invitation_only: 'Invitation Only',
      closed: 'Closed',
    }
    await this.page.locator(`[role="option"]:has-text("${labels[mode]}")`).click()
    // Wait for mutation to settle
    await this.page.waitForTimeout(300)
  }

  /** Add an allowed signup domain (only visible when domain_restricted) */
  async addAllowedDomain(domain: string) {
    await this.page.locator('[data-testid="auth-add-domain-input"]').fill(domain)
    await this.page.locator('[data-testid="auth-add-domain-button"]').click()
    await this.page.waitForTimeout(300)
  }

  /** Toggle a switch by data-testid */
  async setSwitch(testId: string, checked: boolean) {
    const sw = this.page.locator(`[data-testid="${testId}"]`)
    const current = await sw.getAttribute('data-state')
    const isChecked = current === 'checked'
    if (isChecked !== checked) {
      await sw.click()
      await this.page.waitForTimeout(300)
    }
  }

  /** Set a number input by data-testid */
  async setNumberInput(testId: string, value: number) {
    const input = this.page.locator(`[data-testid="${testId}"]`)
    await input.fill(String(value))
    // Trigger change by pressing Tab
    await input.press('Tab')
    await this.page.waitForTimeout(300)
  }
}
