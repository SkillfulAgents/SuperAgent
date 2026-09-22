import { test, expect, type Locator, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import {
  createAgent,
  createSession,
  getAgentItem,
  uniqueName,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

async function dispatchFileDrag(
  target: Locator,
  eventType: 'dragenter' | 'drop',
  fileName: string,
) {
  await target.evaluate((element, { eventType, fileName }) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['sidebar drop'], fileName, { type: 'text/plain' }))
    element.dispatchEvent(new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }))
  }, { eventType, fileName })
}

function attachmentPreview(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('attachment-preview').filter({ hasText: fileName })
}

test.describe('Sidebar file drop', () => {
  let agent: TestAgent

  test.beforeEach(async ({ page, request }, testInfo: TestInfo) => {
    agent = await createAgent(request, uniqueName(testInfo, 'Sidebar Drop Agent'))

    const appPage = new AppPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('dropping a file on an agent row opens its home composer with the attachment', async ({ page }) => {
    const fileName = 'agent-sidebar-drop.txt'
    const row = getAgentItem(page, agent).locator('xpath=..')
    await expect(row).toBeVisible()

    await dispatchFileDrag(row, 'dragenter', fileName)
    await expect(row).toHaveAttribute('data-file-drop-active', '')

    await dispatchFileDrag(row, 'drop', fileName)

    await expect(page).toHaveURL(/\/agents\/[^/]+$/)
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(agent.name)
    await expect(page.getByTestId('home-message-input')).toBeVisible()
    await expect(attachmentPreview(page, fileName)).toBeVisible()
  })

  test('dropping a file on a session row opens its composer with the attachment', async ({ page, request }) => {
    const session: TestSession = await createSession(request, agent, 'Create a session for sidebar drop coverage')
    const fileName = 'session-sidebar-drop.txt'
    await page.reload()
    await new AppPage(page).waitForAgentsLoaded()
    await new AgentPage(page).expandAgent(agent.name)

    const row = page.getByTestId(`session-item-${session.id}`).locator('xpath=ancestor::li[1]')
    await expect(row).toBeVisible({ timeout: 15000 })

    await dispatchFileDrag(row, 'dragenter', fileName)
    await expect(row).toHaveAttribute('data-file-drop-active', '')

    await dispatchFileDrag(row, 'drop', fileName)

    await expect(page).toHaveURL(new RegExp(`/agents/${agent.slug}/sessions/${session.id}$`))
    await expect(page.getByTestId('message-input')).toBeVisible()
    await expect(attachmentPreview(page, fileName)).toBeVisible()
  })
})
