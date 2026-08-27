/**
 * A homepage template pick carried through signup installs on the
 * cloud-style first run. The workspace stays on screen. Today's install
 * dialog, then the setup spinner, then the agent. No create screen.
 *
 * Serial on a dedicated server (auth-template-handoff project). The admin
 * signs up, skips the wizard once so the app shell exists, then the test
 * resets that user's setupCompleted and lands with the slug in the URL.
 */
import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'

test.describe.configure({ mode: 'serial' })

const admin = { name: 'Handoff Admin', email: 'handoff-admin@test.com', password: 'password123' }

test.describe('Signup template handoff', () => {
  test('admin signs up and finishes the first-run screen once', async ({ request, user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)
    await user1Page.context().clearCookies()
    await user1Page.goto('/')
    await authPage.expectVisible()
    const config = await (await request.get('/api/auth-config')).json() as { hasUsers: boolean }
    if (config.hasUsers) await authPage.signIn(admin.email, admin.password)
    else await authPage.signUpOrSignIn(admin.name, admin.email, admin.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
  })

  test('template_slug installs on the workspace with no first-run screen', async ({ user1Page }) => {
    // Per-user flag, so the PUT must ride the signed-in page's cookies, not the bare request fixture.
    const reset = await user1Page.request.put('/api/user-settings', {
      data: { setupCompleted: false, onboardingProgress: null },
    })
    expect(reset.ok()).toBe(true)

    await user1Page.goto('/?template_slug=e2e-onboarding-template')

    const sidebar = user1Page.locator('[data-testid="app-sidebar"]')
    await expect(sidebar).toBeVisible()
    await expect(user1Page.locator('[data-testid="wizard-container"]')).toHaveCount(0)
    await expect(user1Page.locator('[data-testid="create-agent-prompt"]')).toHaveCount(0)

    const install = user1Page.getByTestId('template-install-status')
    const setup = user1Page.getByTestId('onboarding-setup-dialog')
    await expect(install.or(setup).first()).toBeVisible({ timeout: 15_000 })

    await expect(user1Page).toHaveURL(/\/agents\//, { timeout: 30_000 })
    await expect(user1Page.locator('[data-testid="wizard-container"]')).toHaveCount(0)
    await expect(user1Page.locator('[data-testid="create-agent-prompt"]')).toHaveCount(0)
    await expect(setup).toBeHidden()
    await expect(sidebar.getByText('E2E Onboarding Template', { exact: true })).toBeVisible()

    await expect.poll(async () => {
      const settings = await (await user1Page.request.get('/api/user-settings')).json()
      return settings.setupCompleted === true && settings.onboardingProgress === null
    }).toBe(true)
  })

  test('reload does not bring the first-run screen back', async ({ user1Page }) => {
    await user1Page.goto('/')
    await expect(user1Page.locator('[data-testid="app-sidebar"]')).toBeVisible()
    await expect(user1Page.locator('[data-testid="wizard-container"]')).toHaveCount(0)
  })
})
