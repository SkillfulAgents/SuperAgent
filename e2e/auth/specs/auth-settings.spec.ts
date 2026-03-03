import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { SettingsPage } from '../pages/settings.page'
import { AppPage } from '../../pages/app.page'

// All tests run serially — each test builds on state from previous tests.
// This spec runs AFTER auth-flow.spec.ts (alphabetical order).
// The DB already has user1 (alice@test.com, admin) from the prior spec.
test.describe.configure({ mode: 'serial' })

const admin = { email: 'alice@test.com', password: 'password123' }
const newUser = { name: 'Dave Domain', email: 'dave@allowed.com', password: 'password123' }
const blockedUser = { name: 'Eve External', email: 'eve@blocked.com', password: 'password123' }
const approvalUser = { name: 'Frank Pending', email: 'frank@test.com', password: 'password123' }

test.describe('Auth Settings Enforcement', () => {
  // ── Setup: admin signs in ───────────────────────────────────────────

  test('admin signs in', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)

    await authPage.expectVisible()
    await authPage.signIn(admin.email, admin.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
  })

  // ── Signup Mode: closed ─────────────────────────────────────────────

  test('admin sets signup mode to closed', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('closed')
    await settingsPage.close()
  })

  test('signup tab is hidden when mode is closed', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)

    // Reload to pick up auth-config changes
    await user2Page.reload()
    await authPage.expectVisible()
    await authPage.expectSignupTabNotVisible()
  })

  // ── Signup Mode: invitation_only ────────────────────────────────────

  test('admin sets signup mode to invitation_only', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('invitation_only')
    await settingsPage.close()
  })

  test('signup tab is hidden when mode is invitation_only', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)

    await user2Page.reload()
    await authPage.expectVisible()
    await authPage.expectSignupTabNotVisible()
  })

  // ── Signup Mode: domain_restricted ──────────────────────────────────

  test('admin sets signup mode to domain_restricted with allowed.com', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('domain_restricted')
    await settingsPage.addAllowedDomain('allowed.com')
    await settingsPage.close()
  })

  test('signup tab is visible when mode is domain_restricted', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)

    await user2Page.reload()
    await authPage.expectVisible()
    await authPage.expectSignupTabVisible()
  })

  test('signup from wrong domain shows error', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)

    await authPage.signUp(blockedUser.name, blockedUser.email, blockedUser.password)
    await authPage.expectSignupError()
    await authPage.expectVisible()
  })

  test('signup from allowed domain succeeds', async ({ user3Page }) => {
    const authPage = new AuthPage(user3Page)
    const appPage = new AppPage(user3Page)

    await user3Page.reload()
    await authPage.expectVisible()
    await authPage.signUp(newUser.name, newUser.email, newUser.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
  })

  // ── Signup Mode: open with admin approval ───────────────────────────

  test('admin sets signup to open and enables admin approval', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('open')
    await settingsPage.setSwitch('auth-require-approval', true)
    await settingsPage.close()
  })

  test('new user signs up and sees pending approval', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)

    await user2Page.reload()
    await authPage.expectVisible()
    await authPage.signUp(approvalUser.name, approvalUser.email, approvalUser.password)
    await authPage.expectPendingApproval()
  })

  test('admin unbans the pending user', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)

    await settingsPage.open()
    await settingsPage.navigateToTab('users')

    // The approval user should appear as pending approval
    const userRow = user1Page.locator(`[data-testid="user-row-${approvalUser.email}"]`)
    await expect(userRow).toBeVisible()
    await expect(userRow.locator('text=pending approval')).toBeVisible()

    // Click approve
    await user1Page.locator(`[data-testid="user-approve-${approvalUser.email}"]`).click()

    // Wait for approval to take effect
    await user1Page.waitForTimeout(500)

    // The "pending approval" label should disappear
    await expect(userRow.locator('text=pending approval')).not.toBeVisible()

    await settingsPage.close()
  })

  test('approved user can now sign in', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)
    const appPage = new AppPage(user2Page)

    await user2Page.reload()
    await authPage.expectVisible()
    await authPage.signIn(approvalUser.email, approvalUser.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
  })

  // ── Reset to open mode for cleanup ──────────────────────────────────

  test('admin resets settings to open mode without approval', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.openAuthTab()
    await settingsPage.setSignupMode('open')
    await settingsPage.setSwitch('auth-require-approval', false)
    await settingsPage.close()
  })
})
