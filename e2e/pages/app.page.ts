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
  async waitForAppLoaded(timeout = 15000) {
    await expect(
      this.page
        .locator('[data-testid="app-sidebar"], [data-testid="wizard-container"]')
        .first()
    ).toBeVisible({ timeout })
  }

  /**
   * Dismiss the getting started wizard if it's open.
   * Navigates through all steps using Next/Skip to close it.
   * Requires E2E mock mode (mock API key configured, runtime available).
   */
  async dismissWizardIfVisible(timeout = 2000) {
    const wizard = this.page.locator('[data-testid="wizard-container"]')

    // The app opens the wizard only once its lazy chunk has loaded, which a cold
    // dev server can take many seconds to compile: the shell shows first and the
    // wizard replaces it later. Past `timeout`, keep waiting while the server says
    // this user is still owed the wizard, so a late one is dismissed here rather
    // than covering whatever the test does next.
    const started = Date.now()
    await expect.poll(async () => {
      if (await wizard.isVisible()) return 'wizard'
      if (Date.now() - started < timeout) return 'waiting'
      return (await this.wizardOwed()) ? 'waiting' : 'none'
    }, {
      message: 'the getting-started wizard the server says this user is owed never opened',
      timeout: Math.max(timeout, 20_000),
      intervals: [100, 250, 500],
    }).not.toBe('waiting')
    if (!(await wizard.isVisible())) return

    const manualSetup = this.page.locator('[data-testid="wizard-manual-setup"]')
    // The agent-only wizard opens on its name step (or, for a template
    // handoff, straight on the describe step).
    const agentOnlyHeading = wizard.getByRole('heading', { name: /(name|describe) your first ai teammate/i })
    await expect(manualSetup.or(agentOnlyHeading).first()).toBeVisible({ timeout: 5000 })

    if (await manualSetup.isVisible()) {
      // Full wizard — walk through all steps
      const stepContent = this.page.locator('[data-testid="wizard-step-content"]')
      await manualSetup.click()
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
    } else {
      // Agent-only wizard — just skip
      await this.page.locator('[data-testid="wizard-skip"]').click()
    }

    await expect(wizard).not.toBeVisible({ timeout: 15000 })
  }

  /**
   * Whether the app will open the getting-started wizard for whoever this page is
   * signed in as, from the server's view of what the app's auto-open reads
   * (route-layouts.tsx): the user's own setup and, with sign-in, the workspace's
   * setup and the user's role. Signed out, nobody is owed it. A template handoff
   * opens no wizard and completes the user's setup instead, so it reads as done.
   */
  private async wizardOwed(): Promise<boolean> {
    const api = await this.apiBaseUrl()
    if (api === null) return false
    const userSettings = await this.page.request.get(`${api}/api/user-settings`)
    if (!userSettings.ok()) return false
    if ((await userSettings.json() as { setupCompleted?: boolean }).setupCompleted) return false
    // Local mode mounts no session endpoint, and there everyone gets the wizard.
    const session = await this.page.request.get(`${api}/api/auth/get-session`)
    const body = session.ok() ? await session.json().catch(() => null) as { user?: { role?: string } } | null : null
    const role = body?.user?.role
    if (role === undefined) return true
    const settings = await this.page.request.get(`${api}/api/settings`)
    const workspaceDone = settings.ok() && !!(await settings.json() as { setupCompleted?: boolean }).setupCompleted
    return workspaceDone || role === 'admin'
  }

  /**
   * Where this page's app sends its API calls: its own origin on the web, or, in
   * Electron's built file:// renderer, the address its preload bridge gives the
   * app. Null when the page has neither, so no app is loaded.
   */
  private async apiBaseUrl(): Promise<string | null> {
    const origin = /^https?:\/\/[^/?#]+/.exec(this.page.url())?.[0]
    if (origin) return origin
    return this.page.evaluate(() => window.electronAPI?.getApiUrl() ?? null)
  }

  /**
   * Wait for agents list to finish loading (no loading skeletons)
   */
  async waitForAgentsLoaded() {
    // Wait for sidebar to be visible first
    await this.waitForAppLoaded()
    // Broad safety net: keep this short because the main suite seeds setup as complete.
    await this.dismissWizardIfVisible(500)
    // Wait for the app to be interactive (create agent button visible).
    // If the wizard appeared after our check (race with parallel tests),
    // try dismissing it once more.
    const createBtn = this.page.locator('[data-testid="new-agent-button"]')
    try {
      await expect(createBtn).toBeVisible({ timeout: 3000 })
    } catch {
      await this.dismissWizardIfVisible(500)
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
