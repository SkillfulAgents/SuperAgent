import { test, expect, type AuthFactories, type AuthTestUser } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { SettingsPage } from '../pages/settings.page'
import { AccessPage } from '../pages/access.page'
import { UserBarPage } from '../pages/user-bar.page'
import { AppPage } from '../../pages/app.page'
import { AgentPage } from '../../pages/agent.page'
import { SessionPage } from '../../pages/session.page'

async function resetForOpenSignup(authFactories: AuthFactories) {
  await authFactories.resetAuthData()
  const bootstrapAdmin = await authFactories.createAdmin({ name: 'Bootstrap Admin' })
  await authFactories.resetSettings(bootstrapAdmin)
  await authFactories.resetAuthData()
}

async function seedUsers(authFactories: AuthFactories) {
  await authFactories.resetAuthData()
  const admin = await authFactories.createAdmin({ name: 'Alice Admin' })
  await authFactories.resetSettings(admin)
  const owner = await authFactories.createUser({ name: 'Bob Builder' })
  const member = await authFactories.createUser({ name: 'Carol Viewer' })
  return { admin, owner, member }
}

async function appPageForUser(authFactories: AuthFactories, user: Pick<AuthTestUser, 'email' | 'password'>) {
  const page = await authFactories.pageForUser(user)
  await new AppPage(page).waitForAgentsLoaded()
  return page
}

async function closePage(page: { close: () => Promise<void> }) {
  await page.close().catch(() => {})
}

test.describe('Auth Flow', () => {
  test('auth gate is visible on fresh start', async ({ authFactories }) => {
    await resetForOpenSignup(authFactories)
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)

    await authPage.expectVisible()
    await expect(page.locator('[data-testid="app-sidebar"]')).not.toBeVisible()

    await closePage(page)
  })

  test('first signup becomes admin', async ({ authFactories }) => {
    await resetForOpenSignup(authFactories)
    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)
    const appPage = new AppPage(page)
    const userBar = new UserBarPage(page)
    const settingsPage = new SettingsPage(page)
    const admin = authFactories.uniqueUserDetails({ name: 'Alice Admin', emailPrefix: 'alice' })

    await authPage.signUp(admin.name, admin.email, admin.password)
    await appPage.waitForAgentsLoaded()
    await userBar.expectUserName(admin.name)

    await settingsPage.open()
    await settingsPage.expectTabVisible('users')
    await settingsPage.expectTabVisible('auth')
    await settingsPage.expectTabVisible('llm')
    await settingsPage.expectTabVisible('runtime')
    await settingsPage.close()

    await closePage(page)
  })

  test('subsequent signup becomes regular user', async ({ authFactories }) => {
    await resetForOpenSignup(authFactories)
    const admin = await authFactories.createAdmin({ name: 'Alice Admin' })
    await authFactories.resetSettings(admin)

    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)
    const appPage = new AppPage(page)
    const userBar = new UserBarPage(page)
    const settingsPage = new SettingsPage(page)
    const user = authFactories.uniqueUserDetails({ name: 'Bob Builder', emailPrefix: 'bob' })

    await authPage.signUp(user.name, user.email, user.password)
    await appPage.waitForAgentsLoaded()
    await userBar.expectUserName(user.name)

    await settingsPage.open()
    await settingsPage.expectTabNotVisible('users')
    await settingsPage.expectTabNotVisible('auth')
    await settingsPage.expectTabNotVisible('llm')
    await settingsPage.expectTabNotVisible('runtime')
    await settingsPage.close()

    await closePage(page)
  })

  test('auth errors keep the user on the auth page', async ({ authFactories }) => {
    await resetForOpenSignup(authFactories)
    const admin = await authFactories.createAdmin({ name: 'Alice Admin' })
    await authFactories.resetSettings(admin)

    const page = await authFactories.anonymousPage()
    const authPage = new AuthPage(page)

    await authPage.signUp('Duplicate User', admin.email, 'password123')
    await expect(page.locator('[data-testid="signup-error"]')).toBeVisible()
    await authPage.expectVisible()

    await authPage.signIn(admin.email, 'wrongpassword')
    await expect(page.locator('[data-testid="signin-error"]')).toBeVisible()
    await authPage.expectVisible()

    await closePage(page)
  })

  test('admin can see users and promote a regular user', async ({ authFactories }) => {
    const { admin, owner } = await seedUsers(authFactories)
    const adminPage = await appPageForUser(authFactories, admin)
    const settingsPage = new SettingsPage(adminPage)

    await settingsPage.open()
    await settingsPage.navigateToTab('users')
    await settingsPage.expectUserInList(owner.email)

    const ownerRow = adminPage.locator(`[data-testid="user-row-${owner.email}"]`)
    await ownerRow.locator(`[data-testid="user-role-${owner.email}"]`).click()
    await adminPage.getByRole('option', { name: 'admin' }).click()
    await expect(ownerRow.locator(`[data-testid="user-role-${owner.email}"]`)).toContainText('admin')
    await settingsPage.close()
    await closePage(adminPage)

    const promotedPage = await appPageForUser(authFactories, owner)
    const promotedSettings = new SettingsPage(promotedPage)
    await promotedSettings.open()
    await promotedSettings.expectTabVisible('users')
    await promotedSettings.expectTabVisible('auth')
    await promotedSettings.expectTabVisible('llm')
    await promotedSettings.expectTabVisible('runtime')
    await promotedSettings.close()

    await closePage(promotedPage)
  })

  test('private agents are only visible to their owner', async ({ authFactories }) => {
    const { admin, owner } = await seedUsers(authFactories)
    const agent = await authFactories.createAgent(owner, { name: 'Private Auth Flow Agent' })

    const ownerPage = await appPageForUser(authFactories, owner)
    const ownerAgentPage = new AgentPage(ownerPage)
    ownerAgentPage.rememberAgent(agent)
    await ownerAgentPage.waitForAgentInSidebar(agent.name)
    await closePage(ownerPage)

    const adminPage = await appPageForUser(authFactories, admin)
    const adminAgentPage = new AgentPage(adminPage)
    adminAgentPage.rememberAgent(agent)
    await expect(adminAgentPage.getAgentItem(agent.name)).not.toBeVisible()

    await closePage(adminPage)
  })

  test('authenticated user can create an agent through the UI', async ({ authFactories }, testInfo) => {
    const { owner } = await seedUsers(authFactories)
    const page = await appPageForUser(authFactories, owner)
    const agentPage = new AgentPage(page)
    const agentName = `Auth UI Agent ${testInfo.workerIndex}-${Date.now()}`

    const agent = await agentPage.createAgent(agentName)
    expect(agent.name).toBe(agentName)

    const sidebarItem = await agentPage.waitForAgentInSidebar(agentName, { reloadOnMiss: false })
    await expect(sidebarItem).toContainText(agentName)

    await agentPage.deleteAgentByNameFromApi(agentName)
    await closePage(page)
  })

  test('owner invites a user who can use the agent but cannot administer it', async ({ authFactories }) => {
    const { owner, member } = await seedUsers(authFactories)
    const agent = await authFactories.createAgent(owner, { name: 'Invite Auth Flow Agent' })
    const ownerPage = await appPageForUser(authFactories, owner)
    const ownerAgentPage = new AgentPage(ownerPage)
    const accessPage = new AccessPage(ownerPage)
    ownerAgentPage.rememberAgent(agent)

    await ownerAgentPage.waitForAgentInSidebar(agent.name)
    await accessPage.openAccessTab(agent.name)
    await accessPage.inviteUser(member.email, 'user')
    await accessPage.closeSettings()
    await closePage(ownerPage)

    const memberPage = await appPageForUser(authFactories, member)
    const memberAgentPage = new AgentPage(memberPage)
    const memberSessionPage = new SessionPage(memberPage)
    const memberAccessPage = new AccessPage(memberPage)
    memberAgentPage.rememberAgent(agent)

    await memberAgentPage.waitForAgentInSidebar(agent.name)
    await memberAgentPage.selectAgent(agent.name)
    await memberSessionPage.sendMessage('Hello from invited user')
    await memberSessionPage.waitForUserMessageCount(1)
    await memberSessionPage.waitForResponse(15000)

    await memberPage.locator('[data-testid^="agent-item-"]', { hasText: agent.name }).click({ button: 'right' })
    await expect(memberPage.locator('[data-testid="delete-agent-item"]')).not.toBeVisible()
    await expect(memberPage.locator('[data-testid="leave-agent-item"]')).toBeVisible()
    await memberPage.keyboard.press('Escape')

    await memberPage.locator('[data-testid^="agent-item-"]', { hasText: agent.name }).click({ button: 'right' })
    await memberPage.locator('[data-testid="agent-settings-item"]').click()
    await expect(memberPage.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()
    await memberAccessPage.expectNoPermissionOverlay()
    await memberPage.keyboard.press('Escape')

    await closePage(memberPage)
  })

  test('viewer can read session history but cannot send messages', async ({ authFactories }) => {
    const { owner, member } = await seedUsers(authFactories)
    const agent = await authFactories.createAgent(owner, { name: 'Viewer Auth Flow Agent' })

    const ownerPage = await appPageForUser(authFactories, owner)
    const ownerAgentPage = new AgentPage(ownerPage)
    const ownerSessionPage = new SessionPage(ownerPage)
    ownerAgentPage.rememberAgent(agent)
    await ownerAgentPage.waitForAgentInSidebar(agent.name)
    await ownerAgentPage.selectAgent(agent.name)
    await ownerSessionPage.sendMessage('History from owner')
    await ownerSessionPage.waitForUserMessageCount(1)
    await ownerSessionPage.waitForResponse(15000)
    await closePage(ownerPage)

    await authFactories.inviteUser(owner, agent.slug, member, 'viewer')

    const viewerPage = await appPageForUser(authFactories, member)
    const viewerAgentPage = new AgentPage(viewerPage)
    const viewerSessionPage = new SessionPage(viewerPage)
    viewerAgentPage.rememberAgent(agent)

    await viewerAgentPage.waitForAgentInSidebar(agent.name)
    await viewerAgentPage.selectAgent(agent.name)
    await expect(viewerPage.locator('[data-testid="view-only-banner"]')).toBeVisible()
    await expect(viewerPage.locator('[data-testid="home-message-input"]')).not.toBeVisible()

    await viewerSessionPage.selectFirstSessionInSidebar(viewerAgentPage.getAgentLi(agent.name))
    await expect(viewerSessionPage.getUserMessages().first()).toBeVisible({ timeout: 5000 })
    await expect(viewerPage.locator('[data-testid="message-input"]')).not.toBeVisible()

    await closePage(viewerPage)
  })

  test('owner can change and remove invited user access', async ({ authFactories }) => {
    const { owner, member } = await seedUsers(authFactories)
    const agent = await authFactories.createAgent(owner, { name: 'Role Change Auth Flow Agent' })
    await authFactories.inviteUser(owner, agent.slug, member, 'user')

    const ownerPage = await appPageForUser(authFactories, owner)
    const ownerAgentPage = new AgentPage(ownerPage)
    const accessPage = new AccessPage(ownerPage)
    ownerAgentPage.rememberAgent(agent)

    await ownerAgentPage.waitForAgentInSidebar(agent.name)
    await accessPage.openAccessTab(agent.name)
    const memberEntry = ownerPage.locator('[data-testid^="access-entry-"]').filter({ hasText: member.name })
    await expect(memberEntry).toBeVisible()
    const memberEntryTestId = await memberEntry.getAttribute('data-testid')
    const memberId = memberEntryTestId!.replace('access-entry-', '')

    await accessPage.changeRole(memberId, 'viewer')
    await accessPage.closeSettings()

    const memberPage = await appPageForUser(authFactories, member)
    const memberAgentPage = new AgentPage(memberPage)
    memberAgentPage.rememberAgent(agent)
    await memberAgentPage.waitForAgentInSidebar(agent.name)
    await memberAgentPage.selectAgent(agent.name)
    await expect(memberPage.locator('[data-testid="view-only-banner"]')).toBeVisible()

    await accessPage.openAccessTab(agent.name)
    await ownerPage.locator(`[data-testid="access-remove-${memberId}"]`).click()
    await expect(memberEntry).not.toBeVisible()
    await accessPage.closeSettings()

    await new AppPage(memberPage).reload()
    await expect(memberAgentPage.getAgentItem(agent.name)).not.toBeVisible()

    await closePage(memberPage)
    await closePage(ownerPage)
  })

  test('owners cannot remove the last owner from access', async ({ authFactories }) => {
    const { owner } = await seedUsers(authFactories)
    const agent = await authFactories.createAgent(owner, { name: 'Last Owner Auth Flow Agent' })
    const ownerPage = await appPageForUser(authFactories, owner)
    const ownerAgentPage = new AgentPage(ownerPage)
    const accessPage = new AccessPage(ownerPage)
    ownerAgentPage.rememberAgent(agent)

    await ownerAgentPage.waitForAgentInSidebar(agent.name)
    await accessPage.openAccessTab(agent.name)

    const ownerEntry = ownerPage.locator('[data-testid^="access-entry-"]').filter({ hasText: owner.name })
    await expect(ownerEntry).toBeVisible()
    const ownerEntryTestId = await ownerEntry.getAttribute('data-testid')
    const ownerId = ownerEntryTestId!.replace('access-entry-', '')
    await expect(ownerPage.locator(`[data-testid="access-remove-${ownerId}"]`)).toBeDisabled()
    await accessPage.closeSettings()

    await closePage(ownerPage)
  })

  test('invited user can leave an agent voluntarily', async ({ authFactories }) => {
    const { owner, member } = await seedUsers(authFactories)
    const agent = await authFactories.createAgent(owner, { name: 'Leave Auth Flow Agent' })
    await authFactories.inviteUser(owner, agent.slug, member, 'user')

    const memberPage = await appPageForUser(authFactories, member)
    const memberAgentPage = new AgentPage(memberPage)
    memberAgentPage.rememberAgent(agent)

    await memberAgentPage.waitForAgentInSidebar(agent.name)
    await memberPage.locator('[data-testid^="agent-item-"]', { hasText: agent.name }).click({ button: 'right' })
    await memberPage.locator('[data-testid="leave-agent-item"]').click()
    await expect(memberPage.locator('[data-testid="confirm-leave-agent-dialog"]')).toBeVisible()
    await memberPage.locator('[data-testid="confirm-leave-agent-button"]').click()
    await expect(memberPage.locator('[data-testid="confirm-leave-agent-dialog"]')).not.toBeVisible()
    await expect(memberAgentPage.getAgentItem(agent.name)).not.toBeVisible()

    await closePage(memberPage)
  })

  test('user can sign out and sign back in', async ({ authFactories }) => {
    const { owner } = await seedUsers(authFactories)
    const page = await appPageForUser(authFactories, owner)
    const authPage = new AuthPage(page)
    const appPage = new AppPage(page)
    const userBar = new UserBarPage(page)

    await userBar.signOut()
    await authPage.expectVisible()

    await authPage.signIn(owner.email, owner.password)
    await appPage.waitForAgentsLoaded()
    await userBar.expectUserName(owner.name)

    await closePage(page)
  })
})
