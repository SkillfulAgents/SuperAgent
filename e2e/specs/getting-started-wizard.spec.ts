import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildAgentTemplateZip } from '../helpers/agent-template-zip'
import { AppPage } from '../pages/app.page'
import { WizardPage } from '../pages/wizard.page'

test.describe.configure({ mode: 'serial' })

/**
 * Manual wizard steps (0-indexed):
 *   0: LLM  |  1: Model  |  2: Browser  |  3: Composio  |  4: Runtime  |  5: Privacy  |  6: Agent
 *
 * Skippable: Composio (3), Agent (6)
 * Gated (Next disabled until configured): LLM (needs key), Runtime (needs available runner)
 *
 * In E2E mock mode the mock API key is pre-configured and the runtime reports READY,
 * so Next is enabled on LLM, Model, Browser, Runtime, and Privacy steps.
 */
test.describe('Getting Started Wizard', () => {
  let appPage: AppPage
  let wizardPage: WizardPage

  test.beforeEach(async ({ page, request }) => {
    appPage = new AppPage(page)
    wizardPage = new WizardPage(page)

    // Set a mock API key so the LLM step's Next button is enabled
    await request.put('/api/settings', {
      data: { apiKeys: { anthropicApiKey: 'sk-ant-test-key-for-e2e' } },
    })
  })

  test.afterEach(async ({ request }) => {
    // Restore setupCompleted to true so the next wizard test starts clean.
    await request.put('/api/user-settings', {
      data: { setupCompleted: true },
    })
    // Restore global setupCompleted and clean up mock API key
    await request.put('/api/settings', {
      data: { app: { setupCompleted: true }, apiKeys: { anthropicApiKey: '' } },
    })
  })

  test('auto-opens when setupCompleted is false', async ({ request }) => {
    // Reset setupCompleted via API so the wizard will auto-open on next load
    await request.put('/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()

    // Wizard should auto-open on the welcome screen
    await wizardPage.expectVisible()
    await wizardPage.expectStep(0)
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)

    // Dismiss it for cleanup (wait for each step to render before clicking)
    await wizardPage.clickNext()  // LLM -> Model
    await wizardPage.expectStep(1)
    await wizardPage.clickNext()  // Model -> Browser
    await wizardPage.expectStep(2)
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.expectStep(3)
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.expectStep(4)
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.expectStep(5)
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.expectStep(6)
    await wizardPage.clickSkip()  // Agent (skip = finish)
    await wizardPage.expectNotVisible()
  })

  test('does not auto-open when setupCompleted is true', async ({ request }) => {
    // Ensure setupCompleted is true
    await request.put('/api/user-settings', {
      data: { setupCompleted: true },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()

    // Wizard should NOT be visible
    await wizardPage.expectNotVisible()
  })

  test('navigates through all steps with Next and Back', async ({ page, request }) => {
    // Reset to trigger wizard
    await request.put('/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()

    // Welcome screen (no Back button)
    await wizardPage.expectStep(0)
    await expect(page.getByRole('heading', { name: 'Build your agent workforce' })).toBeVisible()
    await expect(page.locator('[data-testid="wizard-manual-setup"]')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-back"]')).not.toBeVisible()

    // Choose manual path -> Step 0: LLM
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)
    await expect(page.getByText('Connect an LLM provider')).toBeVisible()
    await wizardPage.expectBackEnabled()

    // Step 1: Model
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    await expect(page.getByText('Pick a default model for your agents')).toBeVisible()

    // Go back to Step 0: LLM
    await wizardPage.clickBack()
    await wizardPage.expectStep(0)
    await expect(page.getByText('Connect an LLM provider')).toBeVisible()

    // Forward again to Step 1: Model
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    await expect(page.getByText('Pick a default model for your agents')).toBeVisible()

    // Step 2: Browser
    await wizardPage.clickNext()
    await wizardPage.expectStep(2)
    await expect(page.getByText('Give your agents browser access')).toBeVisible()

    // Step 3: Composio (skippable)
    await wizardPage.clickNext()
    await wizardPage.expectStep(3)
    await expect(page.getByText('Let your agents connect to your apps')).toBeVisible()

    // Step 4: Runtime
    await wizardPage.clickSkip()
    await wizardPage.expectStep(4)
    await expect(page.getByText('Choose a container runtime')).toBeVisible()

    // Step 5: Privacy
    await wizardPage.clickNext()
    await wizardPage.expectStep(5)
    await expect(page.getByText('Help improve Gamut')).toBeVisible()

    // Step 6: Create Agent (skippable)
    await wizardPage.clickNext()
    await wizardPage.expectStep(6)
    await expect(page.getByRole('heading', { name: /name your first ai teammate/i })).toBeVisible()

    // Skip on last step finishes
    await wizardPage.clickSkip()
    await wizardPage.expectNotVisible()
  })

  test('Steel, an advanced browser, needs its API key before Next', async ({ page, request }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: false } })
    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()
    await wizardPage.chooseManualSetup()
    await wizardPage.clickNext() // LLM -> Model
    await wizardPage.expectStep(1)
    await wizardPage.clickNext() // Model -> Browser
    await wizardPage.expectStep(2)

    await page.getByText('Show advanced options').click()
    await page.getByRole('button', { name: /^Steel/ }).click()
    await expect(page.locator('#steel-api-key')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-next"]')).toBeDisabled()

    await page.getByRole('button', { name: /^Tab Tender/ }).click()
    await expect(page.locator('#tabtender-url')).toBeVisible()
    await expect(page.locator('#tabtender-api-key')).toBeVisible()
    await expect(page.locator('[data-testid="wizard-next"]')).toBeDisabled()

    await page.getByRole('button', { name: /^Built-in Browser/ }).click()
    await expect(page.locator('[data-testid="wizard-next"]')).toBeEnabled()

    // Finish the wizard so the next test starts from its welcome screen.
    await wizardPage.clickNext() // Browser -> Composio
    await wizardPage.expectStep(3)
    await wizardPage.clickSkip() // Composio -> Runtime
    await wizardPage.expectStep(4)
    await wizardPage.clickNext() // Runtime -> Privacy
    await wizardPage.expectStep(5)
    await wizardPage.clickNext() // Privacy -> Agent
    await wizardPage.expectStep(6)
    await wizardPage.clickSkip() // Agent (skip = finish)
    await wizardPage.expectNotVisible()
    await request.put('/api/settings', { data: { app: { hostBrowserProvider: null } } })
  })

  test('skip buttons work on optional steps', async ({ request }) => {
    await request.put('/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()

    // Choose manual setup, navigate to Composio (step 3) — first skippable step
    await wizardPage.chooseManualSetup()
    await wizardPage.clickNext() // LLM -> Model
    await wizardPage.expectStep(1)
    await wizardPage.clickNext() // Model -> Browser
    await wizardPage.expectStep(2)
    await wizardPage.clickNext() // Browser -> Composio
    await wizardPage.expectStep(3)

    // Skip should advance to Runtime
    await wizardPage.clickSkip()
    await wizardPage.expectStep(4)

    // Runtime is not skippable — use Next to advance to Privacy
    await wizardPage.clickNext()
    await wizardPage.expectStep(5)

    // Privacy is not skippable — use Next to advance to Agent
    await wizardPage.clickNext()
    await wizardPage.expectStep(6)

    // Skip on last step should finish
    await wizardPage.clickSkip()
    await wizardPage.expectNotVisible()
  })

  test('finishes onboarding after importing the first agent on the job step', async ({ page, request }) => {
    await request.put('/api/user-settings', {
      data: { setupCompleted: false, onboardingProgress: null },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()
    await wizardPage.chooseManualSetup()

    await wizardPage.clickNext() // LLM -> Model
    await wizardPage.expectStep(1)
    await wizardPage.clickNext() // Model -> Browser
    await wizardPage.expectStep(2)
    await wizardPage.clickNext() // Browser -> Composio
    await wizardPage.expectStep(3)
    await wizardPage.clickSkip() // Composio -> Runtime
    await wizardPage.expectStep(4)
    await wizardPage.clickNext() // Runtime -> Privacy
    await wizardPage.expectStep(5)
    await wizardPage.clickNext() // Privacy -> Agent
    await wizardPage.expectStep(6)

    // Name the teammate, then import one in place of describing its job.
    const name = 'Imported in onboarding ' + Date.now()
    await page.getByTestId('agent-identity-name').fill(name)
    await page.getByTestId('agent-identity-continue').click()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wizard-import-'))
    let result: { slug: string; name: string }
    try {
      const zipPath = await buildAgentTemplateZip(path.join(tmpDir, 'plain.zip'), { name: 'Name inside the package' })
      const imported = page.waitForResponse(response =>
        response.request().method() === 'POST' && response.url().endsWith('/api/agents/import-template') && response.status() === 201,
      )
      await page.getByRole('button', { name: 'Import an agent' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('input[type="file"]').setInputFiles(zipPath)
      await dialog.locator('button[type="submit"]').click()
      result = await (await imported).json()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }

    // Both assertions have to be things the wizard itself cannot satisfy: the
    // import navigates to the new agent's page and the name appears in the
    // sidebar, neither of which exists while the wizard overlay is up.
    await expect(page).toHaveURL(/\/agents\//)
    await wizardPage.expectNotVisible()
    await expect(
      page
        .getByTestId(`agent-item-${result.slug}`)
        .getByText(name, { exact: true }),
    ).toBeVisible()

    const response = await request.get('/api/user-settings')
    const settings = await response.json()
    expect(settings.setupCompleted).toBe(true)
    expect(settings.onboardingProgress).toBeNull()
  })

  test('resumes Add-ons in a fresh window with the same agent, first job, and model', async ({ page, request, context }) => {
    await request.put('/api/user-settings', { data: { setupCompleted: false, onboardingProgress: { path: 'manual', stepId: 'agent' } } })
    await appPage.goto()
    const name = 'Resume onboarding ' + Date.now()
    await page.getByTestId('agent-identity-name').fill(name)
    await page.getByTestId('agent-identity-continue').click()
    await expect.poll(async () => (await (await request.get('/api/user-settings')).json()).onboardingProgress.agentDraft?.agent?.slug).toBeTruthy()
    await page.getByTestId('composer-options-trigger').click()
    await page.getByTestId('model-pinned-claude-sonnet-4-6').click()
    await page.keyboard.press('Escape')
    await wizardPage.clickBack()
    await wizardPage.clickBack()
    await wizardPage.clickNext()
    await page.getByTestId('agent-identity-continue').click()
    await expect(page.getByTestId('composer-options-trigger')).toContainText('Sonnet')
    const job = 'Prepare the weekly briefing'
    await page.getByTestId('create-agent-prompt').fill(job)
    await page.getByTestId('create-agent-continue').click()
    await expect(page.getByTestId('agent-addons-step')).toBeVisible()
    await page.close()
    const fresh = await context.newPage()
    await fresh.goto('/')
    await expect(fresh.getByTestId('agent-addons-step')).toBeVisible()
    await new WizardPage(fresh).clickBack()
    await expect(fresh.getByTestId('agent-identity-name-label')).toHaveText(name)
    await expect(fresh.getByTestId('create-agent-prompt')).toHaveText(job)
    await expect(fresh.getByTestId('composer-options-trigger')).toContainText('Sonnet')
    await fresh.getByTestId('create-agent-skip').click()
    await expect(fresh.getByTestId('agent-breadcrumb')).toHaveText(name)
    const rows = await (await request.get('/api/agents')).json()
    expect(rows.filter((agent: { name: string }) => agent.name === name)).toHaveLength(1)
  })

  test('sets setupCompleted after finishing', async ({ request }) => {
    await request.put('/api/user-settings', {
      data: { setupCompleted: false },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()
    await wizardPage.chooseManualSetup()

    // Navigate through and finish (wait for each step to render)
    await wizardPage.clickNext()  // LLM -> Model
    await wizardPage.expectStep(1)
    await wizardPage.clickNext()  // Model -> Browser
    await wizardPage.expectStep(2)
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.expectStep(3)
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.expectStep(4)
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.expectStep(5)
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.expectStep(6)
    await wizardPage.clickSkip()  // Agent (skip = finish)
    await wizardPage.expectNotVisible()

    // Verify setupCompleted is now true via API
    const response = await request.get('/api/user-settings')
    const settings = await response.json()
    expect(settings.setupCompleted).toBe(true)

    // Reload - wizard should not reappear
    await appPage.reload()
    await wizardPage.expectNotVisible()
  })

  test('persists auto-selected Chrome as host browser provider', async ({ request }) => {
    // This test guards against a regression where Chrome is visually auto-selected
    // on the Browser step (via smartDefault) but never actually persisted to
    // settings.app.hostBrowserProvider — leaving the user on the container runtime.

    // Clear any prior hostBrowserProvider value so we're starting from the
    // "never explicitly chose" state this bug targets.
    await request.put('/api/settings', {
      data: { app: { hostBrowserProvider: null } },
    })

    // Only meaningful when Chrome is actually detected (smart default picks Chrome).
    const preRes = await request.get('/api/settings')
    const preSettings = await preRes.json()
    const chromeProvider = preSettings.hostBrowserStatus?.providers?.find(
      (p: { id: string; available: boolean }) => p.id === 'chrome',
    )
    test.skip(!chromeProvider?.available, 'Chrome not detected on this host — smart default would be container')
    expect(preSettings.app?.hostBrowserProvider).toBeUndefined()

    // Reset setupCompleted so the wizard auto-opens
    await request.put('/api/user-settings', {
      data: { setupCompleted: false, onboardingProgress: null },
    })

    await appPage.goto()
    await appPage.waitForAppLoaded()
    await wizardPage.expectVisible()
    await wizardPage.chooseManualSetup()

    // LLM -> Model
    await wizardPage.clickNext()
    await wizardPage.expectStep(1)
    // Model -> Browser
    await wizardPage.clickNext()
    await wizardPage.expectStep(2)

    // Don't click Chrome — the bug is that users rely on the auto-selection.
    // Just advance through the rest of the wizard.
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.expectStep(3)
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.expectStep(4)
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.expectStep(5)
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.expectStep(6)
    await wizardPage.clickSkip()  // Agent -> finish
    await wizardPage.expectNotVisible()

    // Assert via API that hostBrowserProvider was persisted as 'chrome'. The
    // server keeps no settings in memory: GET reads what the database holds.
    const postRes = await request.get('/api/settings')
    const postSettings = await postRes.json()
    expect(postSettings.app?.hostBrowserProvider).toBe('chrome')
  })

  test('re-run wizard button opens wizard from settings', async ({ request }) => {
    // Ensure setup is completed so wizard doesn't auto-open
    await request.put('/api/user-settings', {
      data: { setupCompleted: true },
    })

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Open wizard via settings
    await wizardPage.openViaSettings()
    await wizardPage.expectStep(0)
    await wizardPage.chooseManualSetup()
    await wizardPage.expectStep(0)

    // Dismiss it (wait for each step to render)
    await wizardPage.clickNext()  // LLM -> Model
    await wizardPage.expectStep(1)
    await wizardPage.clickNext()  // Model -> Browser
    await wizardPage.expectStep(2)
    await wizardPage.clickNext()  // Browser -> Composio
    await wizardPage.expectStep(3)
    await wizardPage.clickSkip()  // Composio -> Runtime
    await wizardPage.expectStep(4)
    await wizardPage.clickNext()  // Runtime -> Privacy
    await wizardPage.expectStep(5)
    await wizardPage.clickNext()  // Privacy -> Agent
    await wizardPage.expectStep(6)
    await wizardPage.clickSkip()  // Agent (skip = finish)
    await wizardPage.expectNotVisible()
  })
})
