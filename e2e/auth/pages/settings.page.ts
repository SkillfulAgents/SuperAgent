import { Page, expect } from '@playwright/test'

/**
 * Page object for global settings page interactions
 */
export class SettingsPage {
  constructor(private page: Page) {}

  private async waitForSettingsUpdate(action: () => Promise<unknown>) {
    await Promise.all([
      this.page.waitForResponse((res) =>
        res.url().includes('/api/settings') &&
        res.request().method() === 'PUT' &&
        res.ok()
      ),
      action(),
    ])
  }

  /** Open settings via sidebar footer button */
  async open() {
    // Settings now lives inside the footer account menu
    await this.page.locator('[data-testid="user-menu-trigger"]').click()
    await this.page.locator('[data-testid="settings-button"]').click()
    await expect(this.page.locator('[data-testid="global-settings-page"]')).toBeVisible()
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

  /** Close the settings page via the Back to app nav item */
  async close() {
    await this.page.locator('[data-testid="settings-back"]').click()
    await expect(this.page.locator('[data-testid="global-settings-page"]')).not.toBeVisible()
  }

  // ── Auth Tab helpers ─────────────────────────────────────────────────

  /** Open settings, navigate to Auth tab */
  async openAuthTab() {
    await this.open()
    await this.navigateToTab('auth')
  }

  /** Set the signup mode via the select dropdown */
  async setSignupMode(mode: 'open' | 'domain_restricted' | 'invitation_only' | 'closed') {
    const labels: Record<string, string> = {
      open: 'Open',
      domain_restricted: 'Domain Restricted',
      invitation_only: 'Invitation Only',
      closed: 'Closed',
    }
    const trigger = this.page.locator('[data-testid="auth-signup-mode"]')
    if ((await trigger.textContent())?.includes(labels[mode])) return

    await trigger.click()
    await this.waitForSettingsUpdate(() =>
      this.page.getByRole('option', { name: labels[mode] }).click()
    )
    await expect(trigger).toContainText(labels[mode])
  }

  /** Add an allowed signup domain (only visible when domain_restricted) */
  async addAllowedDomain(domain: string) {
    await this.page.locator('[data-testid="auth-add-domain-input"]').fill(domain)
    await this.waitForSettingsUpdate(() =>
      this.page.locator('[data-testid="auth-add-domain-button"]').click()
    )
    await expect(this.page.getByText(domain)).toBeVisible()
  }

  /** Toggle a switch by data-testid */
  async setSwitch(testId: string, checked: boolean) {
    const sw = this.page.locator(`[data-testid="${testId}"]`)
    const current = await sw.getAttribute('data-state')
    const isChecked = current === 'checked'
    if (isChecked !== checked) {
      await this.waitForSettingsUpdate(() => sw.click())
      await expect(sw).toHaveAttribute('data-state', checked ? 'checked' : 'unchecked')
    }
  }

  /** Set a number input by data-testid */
  async setNumberInput(testId: string, value: number) {
    const input = this.page.locator(`[data-testid="${testId}"]`)
    await this.waitForSettingsUpdate(() => input.fill(String(value)))
    await expect(input).toHaveValue(String(value))
  }
}
