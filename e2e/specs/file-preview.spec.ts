import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const e2eDataDir = path.join(__dirname, '..', '..', '.e2e-data')

async function getLatestAgentSlug(page: import('@playwright/test').Page): Promise<string> {
  const breadcrumb = page.locator('[data-testid="agent-breadcrumb"]')
  const agentName = await breadcrumb.textContent() || ''

  const response = await page.request.get('http://localhost:3000/api/agents')
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

    const filePill = page.locator('.file-pill').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await expect(filePill).toContainText('report.md')

    await filePill.click()

    await expect(page.locator('text=Files').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.prose h1')).toContainText('Test Report', { timeout: 10000 })
  })

  test('closing last tab closes the tray', async ({ page }) => {
    await agentPage.createAgent(`FileClose ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Report')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const filePill = page.locator('.file-pill').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    const trayHeader = page.locator('text=Files').first()
    await expect(trayHeader).toBeVisible({ timeout: 5000 })

    // Scope to the file tab bar to avoid matching pills in chat
    const tabBar = page.locator('[data-testid="file-tab-bar"]')
    const tabButton = tabBar.locator('button', { hasText: 'report.md' })
    await tabButton.hover()
    await tabButton.locator('[role="button"]').click({ force: true })

    await expect(trayHeader).not.toBeVisible({ timeout: 5000 })
  })

  test('re-delivering same file refreshes content', async ({ page }) => {
    await agentPage.createAgent(`FileRedeliver ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Version 1')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const firstPill = page.locator('.file-pill').first()
    await expect(firstPill).toBeVisible({ timeout: 10000 })
    await firstPill.click()

    await expect(page.locator('.prose h1')).toContainText('Version 1', { timeout: 10000 })

    seedWorkspaceFile(agentSlug, 'output/report.md', '# Version 2')
    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const secondPill = page.locator('.file-pill').nth(1)
    await expect(secondPill).toBeVisible({ timeout: 10000 })
    await secondPill.click()

    await expect(page.locator('.prose h1')).toContainText('Version 2', { timeout: 10000 })
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
    const reportPill = page.locator('.file-pill', { hasText: 'report.md' }).first()
    await expect(reportPill).toBeVisible({ timeout: 10000 })
    await reportPill.click()
    await expect(page.locator('text=Files').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.prose h1')).toContainText('Report Content', { timeout: 10000 })

    // Deliver and open the image file → second tab, image renderer.
    await sessionPage.sendMessage('deliver image')
    await sessionPage.waitForResponse(15000)
    const chartPill = page.locator('.file-pill', { hasText: 'chart.png' }).first()
    await expect(chartPill).toBeVisible({ timeout: 10000 })
    await chartPill.click()
    await expect(page.locator('img[alt="chart.png"]')).toBeVisible({ timeout: 10000 })

    // Both files now have tabs.
    const tabBar = page.locator('[data-testid="file-tab-bar"]')
    await expect(tabBar.locator('button', { hasText: 'report.md' })).toBeVisible()
    await expect(tabBar.locator('button', { hasText: 'chart.png' })).toBeVisible()

    // Switch back to the markdown tab → markdown content returns, image is gone.
    await tabBar.locator('button', { hasText: 'report.md' }).click()
    await expect(page.locator('.prose h1')).toContainText('Report Content', { timeout: 5000 })
    await expect(page.locator('img[alt="chart.png"]')).not.toBeVisible()

    // Switch forward to the image tab again → image renderer returns.
    await tabBar.locator('button', { hasText: 'chart.png' }).click()
    await expect(page.locator('img[alt="chart.png"]')).toBeVisible({ timeout: 5000 })
  })
})
