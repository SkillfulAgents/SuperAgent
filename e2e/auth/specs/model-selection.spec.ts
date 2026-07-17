import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'
import { AgentPage } from '../../pages/agent.page'

const admin = { name: 'Model Admin', email: 'model-admin@test.com', password: 'password123' }
const member = { name: 'Model Member', email: 'model-member@test.com', password: 'password123' }
const HAIKU = 'claude-haiku-4-5'

test('auth mode: a non-workspace-admin can select a model in the composer', async ({ user1Page, user2Page }) => {
  const adminAuth = new AuthPage(user1Page)
  const adminApp = new AppPage(user1Page)
  await adminAuth.resetToAuthPage()
  await adminAuth.signUpOrSignIn(admin.name, admin.email, admin.password)
  await adminApp.waitForAppLoaded()
  await adminApp.dismissWizardIfVisible()

  // The first account bootstraps the workspace admin. The second account is a
  // regular workspace member, and creates its own agent (owner ACL) below.
  const memberAuth = new AuthPage(user2Page)
  const memberApp = new AppPage(user2Page)
  const memberAgent = new AgentPage(user2Page)
  await memberAuth.resetToAuthPage()
  await memberAuth.signUpOrSignIn(member.name, member.email, member.password)
  await memberApp.waitForAppLoaded()
  await memberApp.dismissWizardIfVisible()

  await memberAgent.clickCreateAgent()
  await expect(user2Page.locator('[data-testid="home-message-input"]')).toBeVisible()
  await expect(user2Page.locator('[data-testid="home-default-model-card"]')).toHaveCount(0)

  const trigger = user2Page.locator('[data-testid="composer-options-trigger"]')
  await trigger.click()
  await user2Page.locator(`[data-testid="model-pinned-${HAIKU}"]`).click()
  await expect(trigger).toContainText('Haiku 4.5')
})
