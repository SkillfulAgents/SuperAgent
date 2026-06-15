import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'

function uniqueAgentName(prefix: string) {
  return `${prefix}${test.info().workerIndex}-${Date.now()}`
}

async function openAgentSettingsFromContextMenu(
  page: import('@playwright/test').Page,
  agentPage: AgentPage,
  agentName: string,
) {
  const sidebarItem = await agentPage.waitForAgentInSidebar(agentName)
  await expect(sidebarItem).toContainText(agentName, { timeout: 15000 })

  const settingsItem = page.locator('[data-testid="agent-settings-item"]')
  for (let attempt = 0; attempt < 3; attempt++) {
    await sidebarItem.click({ button: 'right', force: true })
    if (await settingsItem.isVisible({ timeout: 1000 }).catch(() => false)) {
      await settingsItem.click()
      return
    }
  }

  await expect(settingsItem).toBeVisible({ timeout: 5000 })
  await settingsItem.click()
}

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
    const agentName = uniqueAgentName('RenameTest')

    // Create an agent
    await agentPage.createAgent(agentName)

    await openAgentSettingsFromContextMenu(page, agentPage, agentName)

    // Wait for the settings dialog
    await expect(page.locator('[data-testid="agent-settings-dialog"]')).toBeVisible()

    // Find the agent name input
    const nameInput = page.locator('#agent-name')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toHaveValue(agentName)

    // Type with actual keyboard (pressSequentially sends real key events)
    await nameInput.fill('')
    await expect(nameInput).toHaveValue('')
    await nameInput.click()
    await nameInput.pressSequentially('Hello World')
    await expect(nameInput).toHaveValue('Hello World')

    // Close dialog and clean up
    await page.keyboard.press('Escape')
    await agentPage.deleteAgentByNameFromApi(agentName)
  })

  test('can rename agent inline from agent home by pressing Enter', async ({ page }) => {
    const agentName = uniqueAgentName('InlineEnter')
    const newName = `${agentName}-Renamed`

    await agentPage.createAgent(agentName)

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
    const sidebarItem = await agentPage.waitForAgentInSidebar(newName, { reloadOnMiss: false })
    await expect(sidebarItem).toContainText(newName)

    await agentPage.deleteAgentByNameFromApi(newName)
  })

  test('can rename agent inline from agent home by clicking save button', async ({ page }) => {
    const agentName = uniqueAgentName('InlineSave')
    const newName = `${agentName}-Renamed`

    await agentPage.createAgent(agentName)

    await page.locator('[data-testid="agent-name"]').click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(newName)

    await page.locator('[data-testid="agent-name-save"]').click()

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(newName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(newName)
    const sidebarItem = await agentPage.waitForAgentInSidebar(newName, { reloadOnMiss: false })
    await expect(sidebarItem).toContainText(newName)

    await agentPage.deleteAgentByNameFromApi(newName)
  })

  test('pressing Escape cancels inline rename without saving', async ({ page }) => {
    const agentName = uniqueAgentName('InlineEscape')

    await agentPage.createAgent(agentName)

    await page.locator('[data-testid="agent-name"]').click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('Should Not Save')
    await nameInput.press('Escape')

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(agentName)

    await agentPage.deleteAgentByNameFromApi(agentName)
  })

  test('control: can type spaces in agent name input when settings opened via button', async ({ page }) => {
    const agentName = uniqueAgentName('RenameCtrl')

    // Create an agent
    await agentPage.createAgent(agentName)

    // Open settings via the button (not context menu)
    await agentPage.openSettings()

    // Find the agent name input
    const nameInput = page.locator('#agent-name')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toHaveValue(agentName)

    // Type with actual keyboard (pressSequentially sends real key events)
    await nameInput.fill('')
    await expect(nameInput).toHaveValue('')
    await nameInput.click()
    await nameInput.pressSequentially('Hello World')
    await expect(nameInput).toHaveValue('Hello World')

    // Close dialog and clean up
    await page.keyboard.press('Escape')
    await agentPage.deleteAgentByNameFromApi(agentName)
  })
})
