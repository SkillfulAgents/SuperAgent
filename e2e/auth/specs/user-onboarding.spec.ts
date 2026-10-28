/**
 * Admin user onboarding and recovery — invitation with a temporary password
 * and admin password-reset, both forcing the change-password gate.
 *
 * Invitation is the only way to onboard users in closed/invitation_only
 * signup mode, and admin reset IS password recovery (no email delivery
 * exists). Both ride the hand-rolled /api/admin/users endpoints and the
 * ForcePasswordChange AuthGate branch, which no test had ever rendered.
 *
 * Serial narrative on a dedicated server (auth-users project): user1 is the
 * admin, user2 is the invitee. Identities are generated inside the tests so
 * a serial-group retry (same live server) mints fresh users instead of
 * colliding with the previous attempt's.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { SettingsPage } from '../pages/settings.page'
import { UserBarPage } from '../pages/user-bar.page'
import { AppPage } from '../../pages/app.page'

test.describe.configure({ mode: 'serial' })

const admin = { name: 'Ivy Admin', email: 'ivy@test.com', password: 'password123' }
const invitedName = 'Nina Newcomer'
const firstPassword = 'first-real-pass-1'
const secondPassword = 'second-real-pass-2'

let invitedEmail = ''
let inviteTempPassword = ''
let resetTempPassword = ''

function userRow(page: Page, email: string) {
  return page.locator(`[data-testid="user-row-${email}"]`)
}

/** The amber "must change password on next login" indicator inside a user row. */
function mustChangeDot(page: Page, email: string) {
  return userRow(page, email).locator('span.rounded-full.bg-amber-500')
}

function changePasswordGate(page: Page) {
  return page.getByText('Change Your Password')
}

/** Read the generated temp password out of the invite/reset result dialog. */
async function readTempPassword(page: Page): Promise<string> {
  const input = page.getByRole('dialog').locator('input.font-mono')
  await expect(input).toBeVisible()
  const value = await input.inputValue()
  expect(value).toBeTruthy()
  return value
}

async function openUsersTab(page: Page) {
  const settingsPage = new SettingsPage(page)
  await settingsPage.open()
  await settingsPage.navigateToTab('users')
}

async function closeSettings(page: Page) {
  await new SettingsPage(page).close()
}

async function submitPasswordChange(page: Page, current: string, next: string) {
  await page.locator('#current-password').fill(current)
  await page.locator('#new-password').fill(next)
  await page.locator('#confirm-password').fill(next)
  await page.getByRole('button', { name: 'Change Password' }).click()
}

/**
 * Complete a forced change and end up inside the app. better-auth rotates the
 * session on changePassword, so the ForcePasswordChange reload can come back
 * signed out — in which case the user re-signs-in with the new password. Handle
 * both the direct-in and re-login outcomes so the flow is deterministic.
 */
async function completeChangeAndEnter(page: Page, current: string, next: string, email: string) {
  const appPage = new AppPage(page)
  const authPage = new AuthPage(page)

  await submitPasswordChange(page, current, next)

  const settled = page.locator('[data-testid="app-sidebar"], [data-testid="auth-page"]').first()
  await expect(settled).toBeVisible({ timeout: 15000 })

  if (await page.locator('[data-testid="auth-page"]').isVisible().catch(() => false)) {
    await authPage.signIn(email, next)
  }

  await appPage.waitForAppLoaded()
  await appPage.dismissWizardIfVisible()
  await expect(changePasswordGate(page)).not.toBeVisible()
}

test.describe('User Onboarding & Recovery', () => {
  test('admin signs up', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)

    await authPage.resetToAuthPage()
    await authPage.signUpOrSignIn(admin.name, admin.email, admin.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
  })

  test('admin invites a user and receives a temporary password', async ({ user1Page }) => {
    invitedEmail = `nina-${Date.now()}@test.com`

    await openUsersTab(user1Page)
    await user1Page.getByRole('button', { name: 'Invite' }).click()

    const dialog = user1Page.getByRole('dialog')
    await dialog.locator('#invite-name').fill(invitedName)
    await dialog.locator('#invite-email').fill(invitedEmail)
    // Role select stays on the default "User".
    await dialog.getByRole('button', { name: 'Invite' }).click()

    // The dialog flips to the temp-password view; capture the password.
    await expect(dialog.getByText('User Invited')).toBeVisible()
    inviteTempPassword = await readTempPassword(user1Page)
    await dialog.getByRole('button', { name: 'Done' }).click()

    // The new user appears in the list, flagged as must-change-password.
    await expect(userRow(user1Page, invitedEmail)).toBeVisible()
    await expect(mustChangeDot(user1Page, invitedEmail)).toBeVisible()
    await closeSettings(user1Page)
  })

  test('invited user is blocked by the change-password gate on first sign-in', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)

    await authPage.signIn(invitedEmail, inviteTempPassword)

    // The gate replaces the whole app — no sidebar until the password changes.
    await expect(changePasswordGate(user2Page)).toBeVisible({ timeout: 15000 })
    await expect(user2Page.locator('[data-testid="app-sidebar"]')).not.toBeVisible()
  })

  test('wrong temporary password errors and keeps the gate up', async ({ user2Page }) => {
    await submitPasswordChange(user2Page, 'not-the-temp-password', firstPassword)

    await expect(user2Page.getByRole('alert')).toBeVisible({ timeout: 10000 })
    await expect(changePasswordGate(user2Page)).toBeVisible()
    await expect(user2Page.locator('[data-testid="app-sidebar"]')).not.toBeVisible()
  })

  test('valid change enters the app and clears the must-change flag', async ({ user1Page, user2Page }) => {
    await completeChangeAndEnter(user2Page, inviteTempPassword, firstPassword, invitedEmail)

    // Admin's Users tab no longer shows the must-change dot. The invitee cleared
    // the flag in its own context, so reload the admin page to force a fresh
    // users fetch rather than reading its cached (stale) list.
    await user1Page.reload()
    await openUsersTab(user1Page)
    await expect(userRow(user1Page, invitedEmail)).toBeVisible()
    await expect(mustChangeDot(user1Page, invitedEmail)).toHaveCount(0)
    await closeSettings(user1Page)
  })

  test('admin password-reset re-arms the gate and invalidates the old password', async ({ user1Page, user2Page }) => {
    const authPage = new AuthPage(user2Page)
    const userBar = new UserBarPage(user2Page)

    // The invitee signs out before the reset so the next sign-in is clean.
    await userBar.signOut()
    await new AuthPage(user2Page).expectVisible()

    // Admin resets from the user row.
    await openUsersTab(user1Page)
    await userRow(user1Page, invitedEmail).getByRole('button', { name: 'Reset password' }).click()
    const dialog = user1Page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Reset Password' }).click()
    await expect(dialog.getByText('Password Reset')).toBeVisible()
    resetTempPassword = await readTempPassword(user1Page)
    expect(resetTempPassword).not.toBe(inviteTempPassword)
    await dialog.getByRole('button', { name: 'Done' }).click()

    // The must-change dot is back.
    await expect(mustChangeDot(user1Page, invitedEmail)).toBeVisible()
    await closeSettings(user1Page)

    // The password the user chose no longer works — the reset replaced it.
    await authPage.signIn(invitedEmail, firstPassword)
    await expect(user2Page.locator('[data-testid="signin-error"]')).toBeVisible()

    // The new temp password signs in — straight into the gate again.
    await authPage.signIn(invitedEmail, resetTempPassword)
    await expect(changePasswordGate(user2Page)).toBeVisible({ timeout: 15000 })

    // Completing the change enters the app.
    await completeChangeAndEnter(user2Page, resetTempPassword, secondPassword, invitedEmail)
  })

  test('audit log records the invite and the reset', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)
    await settingsPage.open()
    await settingsPage.navigateToTab('audit-log')

    // Raw action values render in the Action column; `.first()` tolerates
    // rows accumulated by serial-group retries on the same server.
    await expect(user1Page.getByRole('cell', { name: 'invited', exact: true }).first()).toBeVisible()
    await expect(user1Page.getByRole('cell', { name: 'reset_password', exact: true }).first()).toBeVisible()
    await settingsPage.close()
  })
})
