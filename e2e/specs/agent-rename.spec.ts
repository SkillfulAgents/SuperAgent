import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import {
  createAgent,
  expectAgentNamed,
  getAgentItem,
  gotoAgentHome,
  uniqueName,
} from '../helpers/agents'

test.describe('Agent Rename', () => {
  let appPage: AppPage
  let agentPage: AgentPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  async function createAndOpenAgent(
    request: APIRequestContext,
    page: Page,
    testInfo: TestInfo,
    label: string,
  ) {
    const agent = await createAgent(request, uniqueName(testInfo, label))
    await gotoAgentHome(page, agent)
    await expect(getAgentItem(page, agent)).toBeVisible()
    return agent
  }

  test('can type and save spaces in agent name input when settings opened via context menu', async ({ page, request }, testInfo) => {
    const agent = await createAndOpenAgent(request, page, testInfo, 'Rename Context')
    const newName = uniqueName(testInfo, 'Context Name With Spaces')

    await getAgentItem(page, agent).click({ button: 'right' })
    await page.locator('[data-testid="agent-settings-item"]').click()

    const dialog = page.locator('[data-testid="agent-settings-dialog"]')
    await expect(dialog).toBeVisible()

    const nameInput = page.locator('#agent-name')
    await expect(nameInput).toBeVisible()

    await nameInput.clear()
    await nameInput.click()
    await nameInput.pressSequentially(newName)
    await expect(nameInput).toHaveValue(newName)

    await dialog.getByRole('button', { name: /^Save$/ }).click()
    await expect(dialog).not.toBeVisible({ timeout: 10000 })

    const renamedAgent = await expectAgentNamed(request, agent, newName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(newName)
    await expect(getAgentItem(page, renamedAgent)).toBeVisible()
  })

  test('can rename agent inline from agent home by pressing Enter', async ({ page, request }, testInfo) => {
    const agent = await createAndOpenAgent(request, page, testInfo, 'Inline Enter')
    const newName = uniqueName(testInfo, 'Inline Enter Renamed')

    const nameHeading = page.locator('[data-testid="agent-name"]')
    await expect(nameHeading).toBeVisible()
    await nameHeading.click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(newName)
    await nameInput.press('Enter')

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(newName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(newName)
    const renamedAgent = await expectAgentNamed(request, agent, newName)
    await expect(getAgentItem(page, renamedAgent)).toBeVisible()
  })

  test('can rename agent inline from agent home by clicking save button', async ({ page, request }, testInfo) => {
    const agent = await createAndOpenAgent(request, page, testInfo, 'Inline Save')
    const newName = uniqueName(testInfo, 'Inline Save Renamed')

    await page.locator('[data-testid="agent-name"]').click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(newName)

    await page.locator('[data-testid="agent-name-save"]').click()

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(newName)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(newName)
    const renamedAgent = await expectAgentNamed(request, agent, newName)
    await expect(getAgentItem(page, renamedAgent)).toBeVisible()
  })

  test('pressing Escape cancels inline rename without saving', async ({ page, request }, testInfo) => {
    const agent = await createAndOpenAgent(request, page, testInfo, 'Inline Escape')
    const unsavedName = uniqueName(testInfo, 'Should Not Save')

    await page.locator('[data-testid="agent-name"]').click()

    const nameInput = page.locator('[data-testid="agent-name-input"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(unsavedName)
    await nameInput.press('Escape')

    await expect(nameInput).not.toBeVisible()
    await expect(page.locator('[data-testid="agent-name"]')).toHaveText(agent.name)
    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name)
    await expectAgentNamed(request, agent, agent.name)
    await expect(page.locator('[data-testid^="agent-item-"]', { hasText: unsavedName })).toHaveCount(0)
  })

  test('control: can type spaces in agent name input when settings opened via button without saving', async ({ page, request }, testInfo) => {
    const agent = await createAndOpenAgent(request, page, testInfo, 'Rename Button')
    const unsavedName = uniqueName(testInfo, 'Button Name With Spaces')

    await agentPage.openSettings()

    const dialog = page.locator('[data-testid="agent-settings-dialog"]')
    const nameInput = page.locator('#agent-name')
    await expect(nameInput).toBeVisible()

    await nameInput.clear()
    await nameInput.click()
    await nameInput.pressSequentially(unsavedName)
    await expect(nameInput).toHaveValue(unsavedName)

    await dialog.getByRole('button', { name: /^Cancel$/ }).click()
    await expect(dialog).not.toBeVisible()

    await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name)
    await expectAgentNamed(request, agent, agent.name)
  })
})
