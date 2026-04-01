import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { WizardPage } from '../pages/wizard.page'

test.describe.configure({ mode: 'serial' })

test.describe('Getting Started Wizard', () => {
  let appPage: AppPage
  let wizardPage: WizardPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    wizardPage = new WizardPage(page)
    agentPage = new AgentPage(page)
  })

  test.afterEach(async ({ request }) => {
    // Restore setupCompleted to true so subsequent test files don't see the wizard
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: true },
    })
  })

  test('auto-opens when setupCompleted is false', async ({ page, request }) => {
    // Reset setupCompleted via API so the wizard will auto-open on next load
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()

    // Wizard should auto-open
    await wizardPage.expectVisible()
    await wizardPage.expectStep(0)
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)

    // Dismiss it for cleanup
    await wizardPage.clickNext()  // -> Browser
    await wizardPage.clickSkip()  // -> Composio
    await wizardPage.clickSkip()  // -> Runtime
    await wizardPage.clickSkip()  // -> Agent
    await wizardPage.clickFinish()
    await wizardPage.expectNotVisible()
  })

  test('does not auto-open when setupCompleted is true', async ({ page, request }) => {
    // Ensure setupCompleted is true
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: true },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()

    // Wizard should NOT be visible
    await wizardPage.expectNotVisible()
  })

  test('navigates through all steps with Next and Back', async ({ page, request }) => {
    // Reset to trigger wizard
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()

    // Step 0: Welcome
    await wizardPage.expectStep(0)
    await wizardPage.expectBackDisabled()
    await expect(page.getByText('Welcome to Superagent')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-platform-login"]')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-manual-setup"]')).toBeVisible()

    // Choose the manual path and land on Step 0: LLM
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)
    await expect(page.getByText('Configure LLM Provider')).toBeVisible()
    await wizardPage.expectBackEnabled()

    // Go to Step 1: Browser
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    await expect(page.getByText('Set Up Browser')).toBeVisible()

    // Go back to Step 0: LLM
    await wizardPage.clickBack()
    await wizardPage.expectStep(0)
    await expect(page.getByText('Configure LLM Provider')).toBeVisible()

    // Go forward again to Step 1: Browser
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    await expect(page.getByText('Set Up Browser')).toBeVisible()

    // Go to Step 2: Composio (optional)
    await wizardPage.clickSkip()
    await wizardPage.expectStep(2)
    await expect(page.getByText('Set Up Composio')).toBeVisible()

    // Go to Step 3: Runtime
    await wizardPage.clickSkip()
    await wizardPage.expectStep(3)
    await expect(page.getByText('Set Up Container Runtime')).toBeVisible()

    // Go to Step 4: Create Agent (optional)
    await wizardPage.clickSkip()
    await wizardPage.expectStep(4)
    await expect(page.getByRole('heading', { name: 'Create Your First Agent' })).toBeVisible()

    // Finish
    await wizardPage.clickFinish()
    await wizardPage.expectNotVisible()
  })

  test('skip buttons work on optional steps', async ({ page, request }) => {
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()

    // Choose manual setup, then navigate to Browser (step 1)
    await wizardPage.chooseManualSetup()
    await wizardPage.clickNext() // -> Browser
    await wizardPage.expectStep(1)

    // Skip should advance to Composio
    await wizardPage.clickSkip()
    await wizardPage.expectStep(2)

    // Skip should advance to Runtime
    await wizardPage.clickSkip()
    await wizardPage.expectStep(3)

    // Skip should advance to Agent
    await wizardPage.clickSkip()
    await wizardPage.expectStep(4)

    // Skip on last step should finish
    await wizardPage.clickSkip()
    await wizardPage.expectNotVisible()
  })

  test('sets setupCompleted after finishing', async ({ page, request }) => {
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()
    await wizardPage.chooseManualSetup()

    // Navigate through and finish
    await wizardPage.clickNext()  // -> Browser
    await wizardPage.clickSkip()  // -> Composio
    await wizardPage.clickSkip()  // -> Runtime
    await wizardPage.clickSkip()  // -> Agent
    await wizardPage.clickFinish()
    await wizardPage.expectNotVisible()

    // Verify setupCompleted is now true via API
    const response = await request.get('http://localhost:3000/api/user-settings')
    const settings = await response.json()
    expect(settings.setupCompleted).toBe(true)

    // Reload - wizard should not reappear
    await appPage.reload()
    await wizardPage.expectNotVisible()
  })

  test('can create an agent in the wizard', async ({ page, request }) => {
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()
    await wizardPage.chooseManualSetup()

    // Navigate to Create Agent step
    await wizardPage.clickNext()  // -> Browser
    await wizardPage.clickSkip()  // -> Composio
    await wizardPage.clickSkip()  // -> Runtime
    await wizardPage.clickSkip()  // -> Agent
    await wizardPage.expectStep(4)

    // Create an agent
    const agentName = `Wizard Agent ${Date.now()}`
    await wizardPage.fillAgentName(agentName)
    await wizardPage.clickCreateAgent()

    // Wait for success message
    await expect(page.getByText('Agent created successfully')).toBeVisible()

    // Finish
    await wizardPage.clickFinish()
    await wizardPage.expectNotVisible()

    // Verify agent appears in sidebar
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Clean up
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('re-run wizard button opens wizard from settings', async ({ page, request }) => {
    // Ensure setup is completed so wizard doesn't auto-open
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: true },
    })

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open wizard via settings
    await wizardPage.openViaSettings()
    await wizardPage.expectStep(0)
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)

    // Dismiss it
    await wizardPage.clickNext()  // -> Browser
    await wizardPage.clickSkip()  // -> Composio
    await wizardPage.clickSkip()  // -> Runtime
    await wizardPage.clickSkip()  // -> Agent
    await wizardPage.clickFinish()
    await wizardPage.expectNotVisible()
  })
})
