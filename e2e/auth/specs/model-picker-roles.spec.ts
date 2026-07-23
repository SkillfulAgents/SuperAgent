import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { UserBarPage } from '../pages/user-bar.page'
import { AppPage } from '../../pages/app.page'
import { AgentPage } from '../../pages/agent.page'

// Serial narrative: admin signs up first, then a regular (non-admin) member —
// every later test drives the MEMBER's browser context.
test.describe.configure({ mode: 'serial' })

const admin = { name: 'Ada Admin', email: 'ada@test.com', password: 'password123' }
const member = { name: 'Mia Member', email: 'mia@test.com', password: 'password123' }
const agentName = 'Model Picker Agent'

/**
 * Non-admin users must still get a working model picker. The model catalog
 * used to ride only on the admin-gated GET /api/settings, so for a regular
 * user the composer popover and the agent-home Default Model card rendered
 * with an EMPTY model list (effort options only) — they could not change
 * models at all, even on agents they own.
 */
test.describe('Model picker for non-admin users', () => {
  test('admin signs up first', async ({ user1Page }) => {
    const authPage = new AuthPage(user1Page)
    const appPage = new AppPage(user1Page)
    const userBar = new UserBarPage(user1Page)

    await authPage.resetToAuthPage()
    await authPage.signUpOrSignIn(admin.name, admin.email, admin.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
    await userBar.expectUserName(admin.name)
  })

  test('member signs up as a regular user and creates an agent', async ({ user2Page }) => {
    const authPage = new AuthPage(user2Page)
    const appPage = new AppPage(user2Page)
    const userBar = new UserBarPage(user2Page)
    const agentPage = new AgentPage(user2Page)

    await authPage.resetToAuthPage()
    await authPage.signUpOrSignIn(member.name, member.email, member.password)
    await appPage.waitForAppLoaded()
    await appPage.dismissWizardIfVisible()
    await userBar.expectUserName(member.name)

    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()
  })

  test('member composer popover lists models, not just effort', async ({ user2Page }) => {
    await expect(user2Page.locator('[data-testid="home-message-input"]')).toBeVisible()

    await user2Page.locator('[data-testid="composer-options-trigger"]').click()

    // The model section must list the provider's families. With the catalog
    // gated behind the admin-only settings endpoint these rows are absent and
    // only the effort slider renders.
    await expect(user2Page.locator('[data-testid="model-family-opus"]')).toBeVisible()
    await expect(user2Page.locator('[data-testid="model-family-sonnet"]')).toBeVisible()

    // And a pick actually registers: select Opus, the trigger label follows.
    await user2Page.locator('[data-testid="model-family-opus"]').click()
    await user2Page.keyboard.press('Escape')
    await expect(user2Page.locator('[data-testid="composer-options-trigger"]')).toContainText(/opus/i)
  })

  test('member can change the agent default model from the home card', async ({ user2Page }) => {
    const card = user2Page.locator('[data-testid="home-default-model-card"]')
    await expect(card).toBeVisible()

    await card.locator('[data-testid="settings-model-trigger"]').click()

    // Same catalog, offerLatest surface: family rows carry model-latest-* ids.
    const opusRow = user2Page.locator('[data-testid="model-latest-opus"]')
    await expect(opusRow).toBeVisible()

    // Picking a model must persist as the agent default: the trigger label
    // updates and the "reset to global" affordance appears (custom default set).
    await opusRow.click()
    await user2Page.keyboard.press('Escape')
    await expect(card.locator('[data-testid="settings-model-trigger"]')).toContainText(/opus/i)
    await expect(card.locator('[data-testid="home-default-model-reset"]')).toBeVisible()

    // Durable proof it hit the server, not just local state.
    await user2Page.reload()
    await expect(card.locator('[data-testid="settings-model-trigger"]')).toContainText(/opus/i, { timeout: 15000 })
  })
})
