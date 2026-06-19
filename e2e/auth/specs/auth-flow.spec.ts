import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { SettingsPage } from '../pages/settings.page'
import { AccessPage } from '../pages/access.page'
import { UserBarPage } from '../pages/user-bar.page'
import { AppPage } from '../../pages/app.page'
import { AgentPage } from '../../pages/agent.page'
import { SessionPage } from '../../pages/session.page'

// All tests run serially as a single narrative — each test builds on state from previous tests
test.describe.configure({ mode: 'serial' })

// Test user credentials
const user1 = { name: 'Alice Admin', email: 'alice@test.com', password: 'password123' }
const user2 = { name: 'Bob Builder', email: 'bob@test.com', password: 'password123' }
const user3 = { name: 'Carol Viewer', email: 'carol@test.com', password: 'password123' }
const agentName = 'Auth Test Agent'
// Captured once user2 is viewing the agent — used by the cross-tenant deep-link
// test to prove the loader gates access by URL, not just by sidebar visibility.
let agentSlug = ''

test.describe('Auth Flow', () => {
  // ── Signup & Auth Gate ──────────────────────────────────────────────

  test('auth gate is visible on fresh start', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    await authPage.expectVisible()

    // Sidebar should NOT be visible (auth gate blocks the app)
    await expect(user1Page.locator('[data-testid="app-sidebar"]')).not.toBeVisible()
  })

  test('user1 signs up and becomes admin', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)
    const userBar = new UserBarPage(user1Page)
    const settingsPage = new SettingsPage(user1Page)

    // Sign up User1 (first user becomes admin)
    await authPage.signUp(user1.name, user1.email, user1.password)

    // App should load after signup
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()

    // Verify user name in footer
    await userBar.expectUserName(user1.name)

    // Open settings and verify admin tabs are visible
    await settingsPage.open()
    await settingsPage.expectTabVisible('users')
    await settingsPage.expectTabVisible('auth')
    await settingsPage.expectTabVisible('llm')
    await settingsPage.expectTabVisible('runtime')
    await settingsPage.close()
  })

  test('user2 signs up as regular user (non-admin)', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)
    const appPage = new AppPage(user2Page)
    const userBar = new UserBarPage(user2Page)
    const settingsPage = new SettingsPage(user2Page)

    // Sign up User2 (second user is regular user)
    await authPage.signUp(user2.name, user2.email, user2.password)

    // App should load
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()

    // Verify user name
    await userBar.expectUserName(user2.name)

    // Open settings and verify admin tabs are NOT visible
    await settingsPage.open()
    await settingsPage.expectTabNotVisible('users')
    await settingsPage.expectTabNotVisible('auth')
    await settingsPage.expectTabNotVisible('llm')
    await settingsPage.expectTabNotVisible('runtime')
    await settingsPage.close()
  })

  // ── Auth Error Handling ─────────────────────────────────────────────

  test('sign-up with duplicate email shows error', async ({ user3Page }) => {
    const authPage = new AuthPage(user3Page)

    // Try signing up with user1's already-taken email
    await authPage.signUp('Duplicate User', user1.email, 'password123')

    // Should show error, auth page still visible
    await expect(user3Page.locator('[data-testid="signup-error"]')).toBeVisible()
    await authPage.expectVisible()
  })

  test('sign-in with wrong password shows error', async ({ user3Page }) => {
    const authPage = new AuthPage(user3Page)

    // Try signing in with wrong password
    await authPage.signIn(user1.email, 'wrongpassword')

    // Should show error, auth page still visible
    await expect(user3Page.locator('[data-testid="signin-error"]')).toBeVisible()
    await authPage.expectVisible()
  })

  // ── Admin User Management ──────────────────────────────────────────

  test('admin user1 sees user2 in Users tab', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)

    await settingsPage.open()
    await settingsPage.navigateToTab('users')
    await settingsPage.expectUserInList(user2.email)
    await settingsPage.close()
  })

  // ── Agent Creation & Usage ──────────────────────────────────────────

  test('user2 creates an agent', async ({ user2Page }) => {
    const agentPage = new AgentPage(user2Page)

    await agentPage.createAgent(agentName)

    // Verify agent appears in sidebar
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()
  })

  test('user2 can use the agent', async ({ user2Page }) => {
    const sessionPage = new SessionPage(user2Page)

    // Send a message
    await sessionPage.sendMessage('Hello from user2')

    // Wait for user message to appear
    await sessionPage.waitForUserMessageCount(1)

    // Wait for assistant response
    await sessionPage.waitForResponse(15000)

    // Capture the agent slug from the URL (/agents/$slug/sessions/$id) for
    // the cross-tenant deep-link test below.
    agentSlug = user2Page.url().match(/\/agents\/([^/?#]+)/)?.[1] ?? ''
    expect(agentSlug).toBeTruthy()
  })

  test('user1 does NOT see user2 agent', async ({ user1Page }) => {
    const appPage = new AppPage(user1Page)
    const agentPage = new AgentPage(user1Page)

    // Reload to get fresh agent list
    await appPage.reload()

    // User2's agent should NOT be visible to user1
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })


  // ── Invite & ACL ───────────────────────────────────────────────────

  test('user3 signs up', async ({ user3Page }) => {
    const authPage = new AuthPage(user3Page)
    const appPage = new AppPage(user3Page)
    const userBar = new UserBarPage(user3Page)

    await authPage.signUp(user3.name, user3.email, user3.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
    await userBar.expectUserName(user3.name)
  })

  test('user3 does NOT see agent before invite', async ({ user3Page }) => {
    const agentPage = new AgentPage(user3Page)
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })

  test('user3 deep-linking the agent before invite gets the ambiguous not-found', async ({ user3Page }) => {
    // ACL is enforced by the agent LOADER, not just sidebar visibility. user3 is
    // a regular (non-admin) non-member here, so the server returns 403, which
    // collapses to the SAME ambiguous not-found screen as a 404 (anti-enumeration).
    // (An ADMIN would hit the server's known isAdmin bypass and load it —
    // a server-side bug the client deliberately doesn't compensate for.)
    expect(agentSlug).toBeTruthy()
    await user3Page.goto(`/agents/${agentSlug}`)
    await expect(user3Page.locator('[data-testid="agent-not-found"]')).toBeVisible()
    await expect(user3Page.locator('[data-testid="agent-breadcrumb"]')).not.toBeVisible()
  })

  test('user2 invites user3 with user role', async ({ user2Page }) => {
    const accessPage = new AccessPage(user2Page)

    await accessPage.openAccessTab(agentName)
    await accessPage.inviteUser(user3.email, 'user')
    await accessPage.closeSettings()
  })

  test('user3 can see and use agent after invite', async ({ user3Page }) => {
    const appPage = new AppPage(user3Page)
    const agentPage = new AgentPage(user3Page)
    const sessionPage = new SessionPage(user3Page)

    // Reload to pick up new roles
    await appPage.reload()

    // Agent should now be visible
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Select the agent
    await agentPage.selectAgent(agentName)

    // Send a message
    await sessionPage.sendMessage('Hello from user3')
    await sessionPage.waitForUserMessageCount(1)
    await sessionPage.waitForResponse(15000)
  })

  test('user3 cannot modify agent settings', async ({ user3Page }) => {
    const accessPage = new AccessPage(user3Page)

    // Open agent settings via context menu (find by name text, slug has random suffix)
    await user3Page.locator('[data-testid^="agent-item-"]', { hasText: agentName }).click({ button: 'right' })
    await user3Page.locator('[data-testid="agent-settings-item"]').click()
    await expect(user3Page.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()

    // Permission overlay should be shown
    await accessPage.expectNoPermissionOverlay()

    // Close
    await user3Page.keyboard.press('Escape')
  })

  test('non-owner context menu does not show Delete Agent', async ({ user3Page }) => {
    // Right-click on the agent
    await user3Page.locator('[data-testid^="agent-item-"]', { hasText: agentName }).click({ button: 'right' })

    // "Delete Agent" should NOT be in the context menu (only owners see it)
    await expect(user3Page.locator('[data-testid="delete-agent-item"]')).not.toBeVisible()

    // "Leave Agent" SHOULD be visible for non-owners
    await expect(user3Page.locator('[data-testid="leave-agent-item"]')).toBeVisible()

    // Close context menu
    await user3Page.keyboard.press('Escape')
  })

  // ── Role Changes ──────────────────────────────────────────────────

  test('cannot remove last owner from access list', async ({ user2Page }) => {
    const accessPage = new AccessPage(user2Page)

    await accessPage.openAccessTab(agentName)

    // Find User2's own entry (the sole owner)
    const ownerEntry = user2Page.locator('[data-testid^="access-entry-"]').filter({ hasText: user2.name })
    await expect(ownerEntry).toBeVisible()

    // Extract userId
    const testId = await ownerEntry.getAttribute('data-testid')
    const userId = testId!.replace('access-entry-', '')

    // The remove button should be disabled for the last owner
    await expect(user2Page.locator(`[data-testid="access-remove-${userId}"]`)).toBeDisabled()

    await accessPage.closeSettings()
  })

  test('user2 changes user3 to viewer role', async ({ user2Page }) => {
    const accessPage = new AccessPage(user2Page)

    await accessPage.openAccessTab(agentName)

    // Find user3's entry and change role
    const user3Entry = user2Page.locator('[data-testid^="access-entry-"]').filter({ hasText: user3.name })
    await expect(user3Entry).toBeVisible()

    const testId = await user3Entry.getAttribute('data-testid')
    const userId = testId!.replace('access-entry-', '')

    await accessPage.changeRole(userId, 'viewer')

    await accessPage.closeSettings()
  })

  test('user3 sees view-only mode', async ({ user3Page }) => {
    const appPage = new AppPage(user3Page)
    const agentPage = new AgentPage(user3Page)

    // Reload to pick up role change
    await appPage.reload()

    // Agent should still be visible
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Select the agent
    await agentPage.selectAgent(agentName)

    // View-only banner should be shown
    await expect(user3Page.locator('[data-testid="view-only-banner"]')).toBeVisible()

    // Message input should NOT be visible (viewers can't send messages)
    await expect(user3Page.locator('[data-testid="home-message-input"]')).not.toBeVisible()
  })

  test('user3 can view existing session history', async ({ user3Page }) => {
    const sessionPage = new SessionPage(user3Page)
    const agentPage = new AgentPage(user3Page)

    // Click the first session in the sidebar (helper expands the agent first)
    await sessionPage.selectFirstSessionInSidebar(agentPage.getAgentLi(agentName))

    // Messages should be visible
    await expect(sessionPage.getUserMessages().first()).toBeVisible({ timeout: 5000 })

    // Message input should NOT be rendered (isViewOnly returns null)
    await expect(user3Page.locator('[data-testid="message-input"]')).not.toBeVisible()
  })

  // ── Remove Access ─────────────────────────────────────────────────

  test('user2 removes user3 access', async ({ user2Page }) => {
    const accessPage = new AccessPage(user2Page)

    await accessPage.openAccessTab(agentName)

    // Find user3's entry
    const user3Entry = user2Page.locator('[data-testid^="access-entry-"]').filter({ hasText: user3.name })
    await expect(user3Entry).toBeVisible()

    // Extract userId and click remove
    const testId = await user3Entry.getAttribute('data-testid')
    const userId = testId!.replace('access-entry-', '')
    await user2Page.locator(`[data-testid="access-remove-${userId}"]`).click()

    // Wait for entry to disappear
    await expect(user3Entry).not.toBeVisible()

    await accessPage.closeSettings()
  })

  test('user3 no longer sees agent after access removed', async ({ user3Page }) => {
    const appPage = new AppPage(user3Page)
    const agentPage = new AgentPage(user3Page)

    // Reload to pick up access removal
    await appPage.reload()

    // Agent should no longer be visible
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })

  // ── Re-invite & Leave Agent ────────────────────────────────────────

  test('user2 re-invites user3 with user role', async ({ user2Page }) => {
    const accessPage = new AccessPage(user2Page)

    await accessPage.openAccessTab(agentName)
    await accessPage.inviteUser(user3.email, 'user')
    await accessPage.closeSettings()
  })

  test('user3 leaves agent voluntarily', async ({ user3Page }) => {
    const appPage = new AppPage(user3Page)
    const agentPage = new AgentPage(user3Page)

    // Reload to pick up re-invite
    await appPage.reload()

    // Agent should be visible again
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Right-click → Leave Agent
    await user3Page.locator('[data-testid^="agent-item-"]', { hasText: agentName }).click({ button: 'right' })
    await user3Page.locator('[data-testid="leave-agent-item"]').click()

    // Confirm leave
    await expect(user3Page.locator('[data-testid="confirm-leave-agent-dialog"]')).toBeVisible()
    await user3Page.locator('[data-testid="confirm-leave-agent-button"]').click()

    // Wait for dialog to close and agent to disappear
    await expect(user3Page.locator('[data-testid="confirm-leave-agent-dialog"]')).not.toBeVisible()
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })

  // ── Admin Role Promotion ───────────────────────────────────────────

  test('admin promotes user2 to admin', async ({ user1Page }) => {
    const settingsPage = new SettingsPage(user1Page)

    await settingsPage.open()
    await settingsPage.navigateToTab('users')

    // Find user2's row and change role to admin
    const user2Row = user1Page.locator(`[data-testid="user-row-${user2.email}"]`)
    await expect(user2Row).toBeVisible()
    await user2Row.locator(`[data-testid="user-role-${user2.email}"]`).click()
    await user1Page.getByRole('option', { name: 'admin' }).click()
    await expect(user2Row.locator(`[data-testid="user-role-${user2.email}"]`)).toContainText('admin')
    await settingsPage.close()
  })

  test('user2 now sees admin settings tabs', async ({ user2Page }) => {
    const appPage = new AppPage(user2Page)
    const settingsPage = new SettingsPage(user2Page)

    // Reload to pick up new admin role
    await appPage.reload()
    await appPage.dismissWizardIfVisible()

    // Open settings and verify admin tabs are now visible
    await settingsPage.open()
    await settingsPage.expectTabVisible('users')
    await settingsPage.expectTabVisible('auth')
    await settingsPage.expectTabVisible('llm')
    await settingsPage.expectTabVisible('runtime')
    await settingsPage.close()
  })

  // ── Sign Out / Sign In ─────────────────────────────────────────────

  test('sign out and sign back in', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)
    const appPage = new AppPage(user2Page)
    const userBar = new UserBarPage(user2Page)

    // Sign out
    await userBar.signOut()

    // Auth page should appear
    await authPage.expectVisible()

    // Sign back in
    await authPage.signIn(user2.email, user2.password)

    // App should load
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()

    // Verify user name
    await userBar.expectUserName(user2.name)
  })

  // ── Deep-link Through Login (redirect stash) ───────────

  test('cold deep-link to a protected agent while signed out returns there after login', async ({ user2Page }) => {
    // A signed-out user who cold-deep-links a protected
    // agent URL is sent to the auth gate, and after logging in lands back on that
    // EXACT url — not bounced to home. The redirect target is carried in
    // sessionStorage('superagent.redirect') by AuthGate's cold-load stash and
    // restored by the email-login `consumeRedirectStash()` → `router.history.push`.
    // On a cold deep-link the router never navigates (AuthGate renders <AuthPage>
    // in place of children), so the address bar STAYS on the deep link.
    expect(agentSlug).toBeTruthy()

    const authPage = new AuthPage(user2Page)
    const appPage = new AppPage(user2Page)
    const userBar = new UserBarPage(user2Page)

    // Start signed out (the previous test left user2 signed in).
    await userBar.signOut()
    await authPage.expectVisible()

    // Cold deep-link the protected agent URL while signed out.
    await user2Page.goto(`/agents/${agentSlug}`)

    // Auth gate blocks the app; the address bar STAYS on the deep link (the router
    // never mounted, so it was not bounced to `/`).
    await authPage.expectVisible()
    await expect(user2Page).toHaveURL(new RegExp(`/agents/${agentSlug}$`))
    await expect(user2Page.locator('[data-testid="agent-breadcrumb"]')).not.toBeVisible()

    // The deep-link target is stashed for post-login restore (the actual redirect
    // carrier — a sessionStorage entry, not a URL query param).
    const stashed = await user2Page.evaluate(() => sessionStorage.getItem('superagent.redirect'))
    expect(stashed).toBe(`/agents/${agentSlug}`)

    // Sign in in-place; the email-login restore pushes the stashed target.
    await authPage.signIn(user2.email, user2.password)

    // Lands back on the EXACT agent URL (NOT home), with the agent view mounted.
    await appPage.waitForAppLoaded()
    await expect(user2Page).toHaveURL(new RegExp(`/agents/${agentSlug}$`))
    await expect(user2Page.locator('[data-testid="agent-breadcrumb"]')).toBeVisible()

    // Stash consumed (cleared) so it can't leak into a later navigation.
    const afterLogin = await user2Page.evaluate(() => sessionStorage.getItem('superagent.redirect'))
    expect(afterLogin).toBeNull()
  })
})
