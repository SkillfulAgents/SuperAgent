import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'
import { AgentPage } from '../../pages/agent.page'

const admin = { name: 'Model Admin', email: 'model-admin@test.com', password: 'password123' }
const member = { name: 'Model Member', email: 'model-member@test.com', password: 'password123' }

test('auth mode: a non-workspace-admin can select a model in the composer', async ({ user1Page, user2Page }) => {
  const forbiddenSettingsResponses: string[] = []
  user2Page.on('response', (response) => {
    if (response.url().endsWith('/api/settings') && response.status() === 403) {
      forbiddenSettingsResponses.push(response.url())
    }
  })

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

  // Agent owners may edit their agent-scoped defaults even when they are not
  // workspace admins. Exercise the preference write, not just visibility.
  const defaultModelCard = user2Page.locator('[data-testid="home-default-model-card"]')
  await expect(defaultModelCard).toBeVisible()
  await defaultModelCard.locator('[data-testid="settings-model-trigger"]').click()
  await user2Page.locator('[data-testid="model-latest-sonnet"]').click()
  await expect(defaultModelCard.locator('[data-testid="settings-model-trigger"]')).toContainText('Sonnet · latest')
  await user2Page.keyboard.press('Escape')
  await expect(defaultModelCard.locator('[data-testid="home-default-model-reset"]')).toBeVisible()

  const trigger = user2Page.locator('[data-testid="composer-options-trigger"]')
  await trigger.click()
  // Click the visible family row rather than its hover-only pinned-version chip.
  await user2Page.locator('[data-testid="model-family-haiku"]').click()
  await expect(trigger).toContainText('Haiku')
  expect(forbiddenSettingsResponses).toEqual([])
})
