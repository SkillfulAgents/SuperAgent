import { Page, expect } from '@playwright/test'

/**
 * Page object for the authentication page (sign in / sign up)
 */
export class AuthPage {
  constructor(private page: Page) {}

  private async waitForAuthPost(path: string, action: () => Promise<unknown>) {
    const responsePromise = this.page.waitForResponse((response) =>
      response.url().includes(path) &&
      response.request().method() === 'POST'
    )
    await action()
    return responsePromise
  }

  async resetToAuthPage() {
    await this.page.context().clearCookies()
    await this.page.goto('/')
    await this.page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await this.page.reload()
    await this.expectVisible()
  }

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
    await this.waitForAuthPost('/api/auth/sign-up/email', () =>
      this.page.locator('[data-testid="signup-submit"]').click()
    )
  }

  /** Sign up, falling back to sign-in if the user already exists or no session was attached. */
  async signUpOrSignIn(name: string, email: string, password: string) {
    await this.signUp(name, email, password)

    const appReady = this.page.locator('[data-testid="app-sidebar"], [data-testid="wizard-container"]').first()
    try {
      await appReady.waitFor({ state: 'visible', timeout: 5000 })
      return
    } catch {
      // Stay on the auth page when signup hit an existing user or did not attach a session.
    }

    if (await this.page.locator('[data-testid="auth-page"]').isVisible().catch(() => false)) {
      await this.signIn(email, password)
    }
  }

  /** Sign in an existing user */
  async signIn(email: string, password: string) {
    // Switch to sign-in tab if tabs are visible (they may not be when signup is disabled)
    const signinTab = this.page.locator('[data-testid="auth-tab-signin"]')
    if (await signinTab.isVisible()) {
      await signinTab.click()
    }

    // Fill in the form
    await this.page.locator('#signin-email').fill(email)
    await this.page.locator('#signin-password').fill(password)

    // Submit
    await this.waitForAuthPost('/api/auth/sign-in/email', () =>
      this.page.locator('[data-testid="signin-submit"]').click()
    )
  }

  /** Assert the auth page is visible */
  async expectVisible() {
    await expect(this.page.locator('[data-testid="auth-page"]')).toBeVisible()
  }

  /** Assert the auth page is not visible */
  async expectNotVisible() {
    await expect(this.page.locator('[data-testid="auth-page"]')).not.toBeVisible()
  }

  /** Assert the signup tab IS visible */
  async expectSignupTabVisible() {
    await expect(this.page.locator('[data-testid="auth-tab-signup"]')).toBeVisible()
  }

  /** Assert the signup tab is NOT visible */
  async expectSignupTabNotVisible() {
    await expect(this.page.locator('[data-testid="auth-tab-signup"]')).not.toBeVisible()
  }

  /** Assert the pending approval message is shown */
  async expectPendingApproval() {
    await expect(this.page.locator('[data-testid="pending-approval"]')).toBeVisible()
  }

  /** Assert a signup error is shown */
  async expectSignupError() {
    await expect(this.page.locator('[data-testid="signup-error"]')).toBeVisible()
  }
}
