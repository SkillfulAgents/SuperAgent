import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const e2eDataDir = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')

function getFilePill(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('file-pill').filter({ hasText: fileName })
}

function markdown(page: import('@playwright/test').Page) {
  return page.getByTestId('markdown-renderer')
}

function fileTab(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('file-tab').filter({ hasText: fileName })
}

async function getLatestAgentSlug(page: import('@playwright/test').Page): Promise<string> {
  const breadcrumb = page.locator('[data-testid="agent-breadcrumb"]')
  const agentName = await breadcrumb.textContent() || ''

  const response = await page.request.get('/api/agents')
  const agents = await response.json() as Array<{ slug: string; name: string; createdAt: string }>
  const match = agents.find(a => a.name === agentName.trim())
  if (match) return match.slug

  agents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return agents[0]?.slug || ''
}

function seedWorkspaceFile(agentSlug: string, relativePath: string, content: string | Buffer) {
  const filePath = path.join(e2eDataDir, 'agents', agentSlug, 'workspace', relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
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
    await agentPage.createAgent(`FilePreview ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Test Report\n\nThis is a test with **bold** text.')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const filePill = getFilePill(page, 'report.md').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })

    await filePill.click()

    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByRole('heading', { name: 'Test Report' })).toBeVisible({ timeout: 10000 })
  })

  test('closing last tab closes the tray', async ({ page }) => {
    await agentPage.createAgent(`FileClose ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Report')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const filePill = getFilePill(page, 'report.md').first()
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
    await agentPage.createAgent(`FileRedeliver ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Version 1')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const firstPill = getFilePill(page, 'report.md').first()
    await expect(firstPill).toBeVisible({ timeout: 10000 })
    await firstPill.click()

    await expect(markdown(page).getByRole('heading', { name: 'Version 1' })).toBeVisible({ timeout: 10000 })

    seedWorkspaceFile(agentSlug, 'output/report.md', '# Version 2')
    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const secondPill = getFilePill(page, 'report.md').nth(1)
    await expect(secondPill).toBeVisible({ timeout: 10000 })
    await secondPill.click()

    await expect(markdown(page).getByRole('heading', { name: 'Version 2' })).toBeVisible({ timeout: 10000 })
  })

  test('renders CSV as a table and supports the raw toggle', async ({ page }) => {
    await agentPage.createAgent(`CsvPreview ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(
      agentSlug,
      'output/data.csv',
      'Name,Email,Age\nAlice,alice@example.com,30\nBob,bob@example.com,25',
    )

    await sessionPage.sendMessage('deliver csv')
    await sessionPage.waitForResponse(15000)

    const filePill = getFilePill(page, 'data.csv').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    const csv = page.getByTestId('csv-renderer')
    await expect(csv).toBeVisible({ timeout: 10000 })

    // Header cells and data cells are rendered as a table.
    await expect(csv.getByRole('columnheader', { name: 'Email' })).toBeVisible()
    await expect(csv.getByRole('cell', { name: 'alice@example.com' })).toBeVisible()

    // Toggle to raw text and back.
    await csv.getByRole('button', { name: 'Raw' }).click()
    await expect(csv.getByRole('columnheader', { name: 'Email' })).not.toBeVisible()
    await csv.getByRole('button', { name: 'Table' }).click()
    await expect(csv.getByRole('columnheader', { name: 'Email' })).toBeVisible()
  })

  test('pins a comment to a CSV cell and sends it to the agent', async ({ page }) => {
    await agentPage.createAgent(`CsvComment ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(
      agentSlug,
      'output/data.csv',
      'Name,Email,Age\nAlice,alice@example.com,30\nBob,bob@example.com,25',
    )

    await sessionPage.sendMessage('deliver csv')
    await sessionPage.waitForResponse(15000)

    const filePill = getFilePill(page, 'data.csv').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    const csv = page.getByTestId('csv-renderer')
    await expect(csv).toBeVisible({ timeout: 10000 })

    // Click a data cell → comment affordance appears.
    await csv.getByRole('cell', { name: 'alice@example.com' }).click()
    const overlay = page.locator('[data-comment-overlay]')
    await overlay.getByRole('button', { name: 'Comment' }).click()

    // Add a comment for that cell.
    await page.getByPlaceholder('Add your comment...').fill('This email looks wrong')
    await overlay.getByRole('button', { name: 'Add' }).click()

    // The comment bar shows the cell identifier and the comment text.
    const tray = page.getByTestId('file-preview-tray')
    await expect(tray.getByText('Cell 1:Email', { exact: false })).toBeVisible({ timeout: 5000 })
    await expect(tray.getByText('This email looks wrong')).toBeVisible()

    // Submitting posts the formatted feedback back into the conversation.
    await tray.getByRole('button', { name: 'Submit' }).click()
    await expect(page.getByText('At cell 1:Email', { exact: false })).toBeVisible({ timeout: 10000 })
  })

  test('multiple file tabs, switching, and image rendering', async ({ page }) => {
    await agentPage.createAgent(`MultiFile ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Report Content\n\nDetails here.')
    // A real 1x1 PNG so the <img> actually loads and is visible (the `deliver
    // image` scenario points at output/chart.png — see mock-container-client).
    const onePxPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    seedWorkspaceFile(agentSlug, 'output/chart.png', onePxPng)

    // Deliver and open the markdown file → first tab.
    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)
    const reportPill = getFilePill(page, 'report.md').first()
    await expect(reportPill).toBeVisible({ timeout: 10000 })
    await reportPill.click()
    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByRole('heading', { name: 'Report Content' })).toBeVisible({ timeout: 10000 })

    // Deliver and open the image file → second tab, image renderer.
    await sessionPage.sendMessage('deliver image')
    await sessionPage.waitForResponse(15000)
    const chartPill = getFilePill(page, 'chart.png').first()
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
