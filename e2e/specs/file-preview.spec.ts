import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const e2eDataDir = path.resolve(
  process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '..', '..', '.e2e-data'),
)

function markdown(page: import('@playwright/test').Page) {
  return page.getByTestId('markdown-renderer')
}

function fileTab(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('file-tab').filter({ hasText: fileName })
}

function uniqueAgentName(prefix: string) {
  return `${prefix} ${test.info().workerIndex}-${Date.now()}`
}

function seedWorkspaceFile(agentSlug: string, relativePath: string, content: string | Buffer) {
  const filePath = path.join(e2eDataDir, 'agents', agentSlug, 'workspace', relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

async function sendAndWaitForFilePill(
  sessionPage: SessionPage,
  content: string,
  fileName: string,
  timeout = 15000,
) {
  const filePills = sessionPage.getMessageList().getByTestId('file-pill').filter({ hasText: fileName })
  const filePillCount = await filePills.count()
  await sessionPage.sendMessage(content)
  await expect.poll(() => filePills.count(), { timeout }).toBeGreaterThan(filePillCount)
  return filePills.last()
}

test.describe('File Preview', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('file delivery shows pill and opens preview on click', async ({ page }) => {
    const agent = await agentPage.createAgent(uniqueAgentName('FilePreview'))
    seedWorkspaceFile(agent.slug, 'output/report.md', '# Test Report\n\nThis is a test with **bold** text.')

    const filePill = await sendAndWaitForFilePill(sessionPage, 'deliver file', 'report.md')
    await expect(filePill).toBeVisible({ timeout: 10000 })

    await filePill.click()

    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByRole('heading', { name: 'Test Report' })).toBeVisible({ timeout: 10000 })
  })

  test('closing last tab closes the tray', async ({ page }) => {
    const agent = await agentPage.createAgent(uniqueAgentName('FileClose'))
    seedWorkspaceFile(agent.slug, 'output/report.md', '# Report')

    const filePill = await sendAndWaitForFilePill(sessionPage, 'deliver file', 'report.md')
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    const trayHeader = page.getByTestId('file-preview-header')
    await expect(trayHeader).toBeVisible({ timeout: 5000 })

    const tabButton = fileTab(page, 'report.md')
    await tabButton.hover()
    await tabButton.getByTestId('file-tab-close').click({ force: true })

    await expect(trayHeader).not.toBeVisible({ timeout: 5000 })
  })

  test('re-delivering same file refreshes content', async ({ page }) => {
    const agent = await agentPage.createAgent(uniqueAgentName('FileRedeliver'))
    seedWorkspaceFile(agent.slug, 'output/report.md', '# Version 1')

    const firstPill = await sendAndWaitForFilePill(sessionPage, 'deliver file', 'report.md')
    await expect(firstPill).toBeVisible({ timeout: 10000 })
    await firstPill.click()

    await expect(markdown(page).getByRole('heading', { name: 'Version 1' })).toBeVisible({ timeout: 10000 })

    seedWorkspaceFile(agent.slug, 'output/report.md', '# Version 2')
    const secondPill = await sendAndWaitForFilePill(sessionPage, 'deliver file', 'report.md')
    await expect(secondPill).toBeVisible({ timeout: 10000 })
    await secondPill.click()

    await expect(markdown(page).getByRole('heading', { name: 'Version 2' })).toBeVisible({ timeout: 10000 })
  })

  test('multiple file tabs, switching, and image rendering', async ({ page }) => {
    const agent = await agentPage.createAgent(uniqueAgentName('MultiFile'))
    seedWorkspaceFile(agent.slug, 'output/report.md', '# Report Content\n\nDetails here.')
    // A real 1x1 PNG so the <img> actually loads and is visible (the `deliver
    // image` scenario points at output/chart.png — see mock-container-client).
    const onePxPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    seedWorkspaceFile(agent.slug, 'output/chart.png', onePxPng)

    // Deliver and open the markdown file → first tab.
    const reportPill = await sendAndWaitForFilePill(sessionPage, 'deliver file', 'report.md')
    await expect(reportPill).toBeVisible({ timeout: 10000 })
    await reportPill.click()
    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByRole('heading', { name: 'Report Content' })).toBeVisible({ timeout: 10000 })

    // Deliver and open the image file → second tab, image renderer.
    const chartPill = await sendAndWaitForFilePill(sessionPage, 'deliver image', 'chart.png')
    await expect(chartPill).toBeVisible({ timeout: 10000 })
    await chartPill.click()
    await expect(page.locator('img[alt="chart.png"]')).toBeVisible({ timeout: 10000 })

    // Both files now have tabs.
    await expect(fileTab(page, 'report.md')).toBeVisible()
    await expect(fileTab(page, 'chart.png')).toBeVisible()

    // Switch back to the markdown tab → markdown content returns, image is gone.
    await fileTab(page, 'report.md').click()
    await expect(markdown(page).getByRole('heading', { name: 'Report Content' })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('img[alt="chart.png"]')).not.toBeVisible()

    // Switch forward to the image tab again → image renderer returns.
    await fileTab(page, 'chart.png').click()
    await expect(page.locator('img[alt="chart.png"]')).toBeVisible({ timeout: 5000 })
  })
})
