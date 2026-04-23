import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

test.describe('Agent Rename', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('can type spaces in agent name input when settings opened via context menu', async ({ page }) => {
    const agentName = `RenameTest${Date.now()}`

    // Create an agent
    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Right-click the agent to open context menu
    await agentPage.getAgentItem(agentName).click({ button: 'right' })

    // Click "Settings" in the context menu
    await page.locator('[data-testid="agent-settings-item"]').click()

    // Wait for the settings dialog
    await expect(page.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()

    // Find the agent name input
    const nameInput = page.locator('#agent-name')
    await expect(nameInput).toBeVisible()

    // Type with actual keyboard (pressSequentially sends real key events)
    await nameInput.clear()
    await nameInput.click()
    await nameInput.pressSequentially('Hello World')
    await expect(nameInput).toHaveValue('Hello World')

    // Close dialog and clean up
    await page.keyboard.press('Escape')
    await agentPage.deleteAgent()
  })

  test('can rename agent inline from agent home by pressing Enter', async ({ page }) => {
    const agentName = `InlineEnter${Date.now()}`
    const newName = `${agentName}-Renamed`

    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Click the agent name heading to enter edit mode
    const nameHeading = page.locator('[data-testid="agent-name"]')
    await expect(nameHeading).toBeVisible()
    await nameHeading.click()

    // Input should be focused; replace value and press Enter to save
    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(newName)
    await nameInput.press('Enter')

    // Input should collapse back to the heading with the updated name
    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(newName)

    // Sidebar + breadcrumb should reflect the new name as well
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(newName)
    await expect(agentPage.getAgentItem(newName)).toBeVisible()

    await agentPage.deleteAgent()
  })

  test('can rename agent inline from agent home by clicking save button', async ({ page }) => {
    const agentName = `InlineSave${Date.now()}`
    const newName = `${agentName}-Renamed`

    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    await page.locator('[data-testid="agent-name"]').click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(newName)

    await page.locator('[data-testid="agent-name-save"]').click()

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(newName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(newName)

    await agentPage.deleteAgent()
  })

  test('pressing Escape cancels inline rename without saving', async ({ page }) => {
    const agentName = `InlineEscape${Date.now()}`

    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    await page.locator('[data-testid="agent-name"]').click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('Should Not Save')
    await nameInput.press('Escape')

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(agentName)

    await agentPage.deleteAgent()
  })

  test('control: can type spaces in agent name input when settings opened via button', async ({ page }) => {
    const agentName = `RenameCtrl${Date.now()}`

    // Create an agent
    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Open settings via the button (not context menu)
    await agentPage.openSettings()

    // Find the agent name input
    const nameInput = page.locator('#agent-name')
    await expect(nameInput).toBeVisible()

    // Type with actual keyboard (pressSequentially sends real key events)
    await nameInput.clear()
    await nameInput.click()
    await nameInput.pressSequentially('Hello World')
    await expect(nameInput).toHaveValue('Hello World')

    // Close dialog and clean up
    await page.keyboard.press('Escape')
    await agentPage.deleteAgent()
  })
})
