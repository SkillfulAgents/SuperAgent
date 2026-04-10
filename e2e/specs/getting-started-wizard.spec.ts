import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { WizardPage } from '../pages/wizard.page'

test.describe.configure({ mode: 'serial' })

/**
 * Manual wizard steps (0-indexed):
 *   0: LLM  |  1: Browser  |  2: Composio  |  3: Runtime  |  4: Privacy  |  5: Agent
 *
 * Skippable: Composio (2), Agent (5)
 * Gated (Next disabled until configured): LLM (needs key), Runtime (needs available runner)
 *
 * In E2E mock mode the mock API key is pre-configured and the runtime reports READY,
 * so Next is enabled on LLM, Browser, Runtime, and Privacy steps.
 */
test.describe('Getting Started Wizard', () => {
  let appPage: AppPage
  let wizardPage: WizardPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page, request }) => {
    appPage = new AppPage(page)
    wizardPage = new WizardPage(page)
    agentPage = new AgentPage(page)

    // Set a mock API key so the LLM step's Next button is enabled
    await request.put('http://localhost:3000/api/settings', {
      data: { apiKeys: { anthropicApiKey: 'sk-ant-test-key-for-e2e' } },
    })
  })

  test.afterEach(async ({ request }) => {
    // Restore setupCompleted to true so subsequent test files don't see the wizard
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: true },
    })
    // Clean up mock API key
    await request.put('http://localhost:3000/api/settings', {
      data: { apiKeys: { anthropicApiKey: '' } },
    })
  })

  test('auto-opens when setupCompleted is false', async ({ page, request }) => {
    // Reset setupCompleted via API so the wizard will auto-open on next load
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()

    // Wizard should auto-open on the welcome screen
    await wizardPage.expectVisible()
    await wizardPage.expectStep(0)
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)

    // Dismiss it for cleanup
    await wizardPage.clickNext()  // LLM -> Browser
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.clickSkip()  // Agent (skip = finish)
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

    // Welcome screen (no Back button)
    await wizardPage.expectStep(0)
    await expect(page.getByText('Welcome to Superagent')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-platform-login"]')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-manual-setup"]')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-back"]')).not.toBeVisible()

    // Choose manual path -> Step 0: LLM
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)
    await expect(page.getByText('Configure LLM Provider')).toBeVisible()
    await wizardPage.expectBackEnabled()

    // Step 1: Browser
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    await expect(page.getByText('Set Up Browser')).toBeVisible()

    // Go back to Step 0: LLM
    await wizardPage.clickBack()
    await wizardPage.expectStep(0)
    await expect(page.getByText('Configure LLM Provider')).toBeVisible()

    // Forward again to Step 1: Browser
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    await expect(page.getByText('Set Up Browser')).toBeVisible()

    // Step 2: Composio (skippable)
    await wizardPage.clickNext()
    await wizardPage.expectStep(2)
    await expect(page.getByText('Set Up Composio')).toBeVisible()

    // Step 3: Runtime
    await wizardPage.clickSkip()
    await wizardPage.expectStep(3)
    await expect(page.getByText('Set Up Container Runtime')).toBeVisible()

    // Step 4: Privacy
    await wizardPage.clickNext()
    await wizardPage.expectStep(4)
    await expect(page.getByText('Help improve Superagent')).toBeVisible()

    // Step 5: Create Agent (skippable)
    await wizardPage.clickNext()
    await wizardPage.expectStep(5)
    await expect(page.getByRole('heading', { name: 'Create Your First Agent' })).toBeVisible()

    // Skip on last step finishes
    await wizardPage.clickSkip()
    await wizardPage.expectNotVisible()
  })

  test('skip buttons work on optional steps', async ({ page, request }) => {
    await request.put('http://localhost:3000/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()

    // Choose manual setup, navigate to Composio (step 2) — first skippable step
    await wizardPage.chooseManualSetup()
    await wizardPage.clickNext() // LLM -> Browser
    await wizardPage.expectStep(1)
    await wizardPage.clickNext() // Browser -> Composio
    await wizardPage.expectStep(2)

    // Skip should advance to Runtime
    await wizardPage.clickSkip()
    await wizardPage.expectStep(3)

    // Runtime is not skippable — use Next to advance to Privacy
    await wizardPage.clickNext()
    await wizardPage.expectStep(4)

    // Privacy is not skippable — use Next to advance to Agent
    await wizardPage.clickNext()
    await wizardPage.expectStep(5)

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
    await wizardPage.clickNext()  // LLM -> Browser
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.clickSkip()  // Agent (skip = finish)
    await wizardPage.expectNotVisible()

    // Verify setupCompleted is now true via API
    const response = await request.get('http://localhost:3000/api/user-settings')
    const settings = await response.json()
    expect(settings.setupCompleted).toBe(true)

    // Reload - wizard should not reappear
    await appPage.reload()
    await wizardPage.expectNotVisible()
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
    await wizardPage.clickNext()  // LLM -> Browser
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.clickSkip()  // Agent (skip = finish)
    await wizardPage.expectNotVisible()
  })
})
