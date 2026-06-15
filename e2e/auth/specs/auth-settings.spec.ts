import { test, expect, type AuthFactories, type AuthTestUser } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { SettingsPage } from '../pages/settings.page'
import { AppPage } from '../../pages/app.page'

test.describe.configure({ mode: 'serial' })

type SignupUser = Pick<AuthTestUser, 'name' | 'email' | 'password'>

let admin: AuthTestUser
let approvalUser: SignupUser

async function adminAppPage(authFactories: AuthFactories) {
  const page = await authFactories.pageForUser(admin)
  const appPage = new AppPage(page)
  await appPage.waitForAgentsLoaded()
  return page
}

test.describe('Auth Settings Enforcement', () => {
  test.beforeAll(async ({ authFactories }) => {
    await authFactories.resetAuthData()
    admin = await authFactories.createAdmin({ name: 'Auth Settings Admin' })
    await authFactories.resetSettings(admin)
  })

  test.afterAll(async ({ authFactories }) => {
    if (admin) {
      await authFactories.resetSettings(admin)
    }
  })

  // ── Setup: admin signs in ───────────────────────────────────────────

  test('admin signs in', async ({ authFactories }) => {
    const page = await authFactories.pageForUser(admin)
    const appPage = new AppPage(page)
    await appPage.waitForAgentsLoaded()
  })

  test('admin sees grouped "My Settings" / "Admin Settings" sections', async ({ authFactories }) => {
    const page = await adminAppPage(authFactories)
    const settingsPage = new SettingsPage(page)
    await settingsPage.open()
    // Both group labels should render in admin auth mode.
    await expect(page.locator('[data-sidebar="group-label"]', { hasText: 'My Settings' })).toBeVisible()
    await expect(page.locator('[data-sidebar="group-label"]', { hasText: 'Admin Settings' })).toBeVisible()
    await settingsPage.close()
  })

  // ── Signup Mode: closed ─────────────────────────────────────────────

  test('admin sets signup mode to closed', async ({ authFactories }) => {
    const page = await adminAppPage(authFactories)
    const settingsPage = new SettingsPage(page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('closed')
    await settingsPage.close()
  })

  test('signup tab is hidden when mode is closed', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)

    await authPage.expectVisible()
    await authPage.expectSignupTabNotVisible()
  })

  // ── Signup Mode: invitation_only ────────────────────────────────────

  test('admin sets signup mode to invitation_only', async ({ authFactories }) => {
    const page = await adminAppPage(authFactories)
    const settingsPage = new SettingsPage(page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('invitation_only')
    await settingsPage.close()
  })

  test('signup tab is hidden when mode is invitation_only', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)

    await authPage.expectVisible()
    await authPage.expectSignupTabNotVisible()
  })

  // ── Signup Mode: domain_restricted ──────────────────────────────────

  test('admin sets signup mode to domain_restricted with allowed.com', async ({ authFactories }) => {
    const page = await adminAppPage(authFactories)
    const settingsPage = new SettingsPage(page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('domain_restricted')
    await settingsPage.addAllowedDomain('allowed.com')
    await settingsPage.close()
  })

  test('signup tab is visible when mode is domain_restricted', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)

    await authPage.expectVisible()
    await authPage.expectSignupTabVisible()
  })

  test('signup from wrong domain shows error', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)
    const blockedUser = authFactories.uniqueUserDetails({
      name: 'Eve External',
      emailPrefix: 'eve',
      emailDomain: 'blocked.com',
    })

    await authPage.signUp(blockedUser.name, blockedUser.email, blockedUser.password)
    await authPage.expectSignupError()
    await authPage.expectVisible()
  })

  test('signup from allowed domain succeeds', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)
    const appPage = new AppPage(page)
    const newUser = authFactories.uniqueUserDetails({
      name: 'Dave Domain',
      emailPrefix: 'dave',
      emailDomain: 'allowed.com',
    })

    await authPage.expectVisible()
    await authPage.signUp(newUser.name, newUser.email, newUser.password)
    await appPage.waitForAgentsLoaded()
  })

  // ── Signup Mode: open with admin approval ───────────────────────────

  test('admin sets signup to open and enables admin approval', async ({ authFactories }) => {
    const page = await adminAppPage(authFactories)
    const settingsPage = new SettingsPage(page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('open')
    await settingsPage.setSwitch('auth-require-approval', true)
    await settingsPage.close()
  })

  test('new user signs up and sees pending approval', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)
    approvalUser = authFactories.uniqueUserDetails({
      name: 'Frank Pending',
      emailPrefix: 'frank',
    })

    await authPage.expectVisible()
    await authPage.signUp(approvalUser.name, approvalUser.email, approvalUser.password)
    await authPage.expectPendingApproval()
  })

  test('admin unbans the pending user', async ({ authFactories }) => {
    const page = await adminAppPage(authFactories)
    const settingsPage = new SettingsPage(page)

    await settingsPage.open()
    await settingsPage.navigateToTab('users')

    // The approval user should appear as pending approval.
    const userRow = page.locator(`[data-testid="user-row-${approvalUser.email}"]`)
    await expect(userRow).toBeVisible()
    await expect(userRow.getByText('pending approval')).toBeVisible()

    await page.locator(`[data-testid="user-approve-${approvalUser.email}"]`).click()
    await expect(userRow.getByText('pending approval')).not.toBeVisible()

    await settingsPage.close()
  })

  test('approved user can now sign in', async ({ authFactories }) => {
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)
    const appPage = new AppPage(page)

    await authPage.expectVisible()
    await authPage.signIn(approvalUser.email, approvalUser.password)
    await appPage.waitForAgentsLoaded()
  })

  // ── Reset to open mode for cleanup ──────────────────────────────────

  test('admin resets settings to open mode without approval', async ({ authFactories }) => {
    await authFactories.resetSettings(admin)
  })
})
