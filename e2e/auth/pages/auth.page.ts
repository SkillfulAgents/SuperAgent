import { Page, expect } from '@playwright/test'

/**
 * Page object for the authentication page (sign in / sign up)
 */
export class AuthPage {
  constructor(private page: Page) {}

  /** Sign up a new user */
  async signUp(name: string, email: string, password: string) {
    // Switch to sign-up tab
    await this.page.locator('[data-testid="auth-tab-signup"]').click()

    // Fill in the form
    await this.page.locator('#signup-name').fill(name)
    await this.page.locator('#signup-email').fill(email)
    await this.page.locator('#signup-password').fill(password)
    await this.page.locator('#signup-confirm').fill(password)

    // Submit
    await this.page.locator('[data-testid="signup-submit"]').click()
  }

  /** Sign in an existing user */
  async signIn(email: string, password: string) {
    // Make sure we're on sign-in tab
    await this.page.locator('[data-testid="auth-tab-signin"]').click()

    // Fill in the form
    await this.page.locator('#signin-email').fill(email)
    await this.page.locator('#signin-password').fill(password)

    // Submit
    await this.page.locator('[data-testid="signin-submit"]').click()
  }

  /** Assert the auth page is visible */
  async expectVisible() {
    await expect(this.page.locator('[data-testid="auth-page"]')).toBeVisible()
  }

  /** Assert the auth page is not visible */
  async expectNotVisible() {
    await expect(this.page.locator('[data-testid="auth-page"]')).not.toBeVisible()
  }
}
