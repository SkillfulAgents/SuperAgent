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

  test('folder bookmark traverses lazily and opens files while preserving tree state', async ({ page }) => {
    await agentPage.createAgent(`FolderPreview ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'reports/overview.md', '# Reports Overview')
    seedWorkspaceFile(agentSlug, 'reports/2026/july.md', '# July Report')
    seedWorkspaceFile(
      agentSlug,
      'bookmarks.json',
      JSON.stringify([{ name: 'Reports', folder: '/workspace/reports' }]),
    )

    await page.reload()
    await appPage.waitForAgentsLoaded()

    // The Agent Directory uses the same built-in folder browser on web and
    // Electron; it no longer delegates to an OS-level directory action.
    await page.getByTestId('home-agent-directory-open-browser').click()
    await expect(page.locator(
      '[data-testid="folder-entry"][data-entry-path="/workspace/reports"]',
    )).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Hide files panel' }).click()

    await page.getByRole('button', { name: 'Reports' }).click()
    await expect(page.getByTestId('folder-browser')).toBeVisible({ timeout: 5000 })

    const year = page.locator(
      '[data-testid="folder-entry"][data-entry-path="/workspace/reports/2026"]',
    )
    await expect(year).toHaveAttribute('aria-expanded', 'false')
    await year.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Bookmark' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Bookmark' }).click()
    await expect.poll(async () => {
      const response = await page.request.get(`/api/agents/${agentSlug}/bookmarks`)
      return await response.json()
    }).toContainEqual({ name: '2026', folder: '/workspace/reports/2026' })

    await year.click()
    await expect(year).toHaveAttribute('aria-expanded', 'true')

    const july = page.locator(
      '[data-testid="folder-entry"][data-entry-path="/workspace/reports/2026/july.md"]',
    )
    await july.click()
    await expect(markdown(page).getByRole('heading', { name: 'July Report' })).toBeVisible({ timeout: 10000 })

    await fileTab(page, 'reports').click()
    await expect(year).toHaveAttribute('aria-expanded', 'true')
    await expect(july).toBeVisible()

    const overview = page.locator(
      '[data-testid="folder-entry"][data-entry-path="/workspace/reports/overview.md"]',
    )
    await overview.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy contents' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Bookmark' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('overview.md')

    await overview.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: 'File name' }).fill('summary.md')
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click()

    const summary = page.locator(
      '[data-testid="folder-entry"][data-entry-path="/workspace/reports/summary.md"]',
    )
    await expect(summary).toBeVisible()
    await summary.click()
    await expect(markdown(page).getByRole('heading', { name: 'Reports Overview' })).toBeVisible({ timeout: 10000 })

    await fileTab(page, 'reports').click()
    await summary.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const deleteDialog = page.getByRole('alertdialog')
    await expect(deleteDialog.getByRole('heading', { name: 'Delete File' })).toBeVisible()
    await deleteDialog.getByRole('button', { name: 'Delete' }).click()
    await expect(summary).not.toBeVisible()

    await year.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByRole('textbox', { name: 'Folder name' }).fill('archive')
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click()

    const archive = page.locator(
      '[data-testid="folder-entry"][data-entry-path="/workspace/reports/archive"]',
    )
    await expect(archive).toBeVisible()
    await archive.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const deleteFolderDialog = page.getByRole('alertdialog')
    await expect(deleteFolderDialog.getByRole('heading', { name: 'Delete Folder' })).toBeVisible()
    await deleteFolderDialog.getByRole('button', { name: 'Delete' }).click()
    await expect(archive).not.toBeVisible()
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

    // The file tray intentionally overlays the composer. Close it before asking
    // the agent to deliver the updated version, then reopen it from the new pill.
    await page.getByRole('button', { name: 'Hide files panel' }).click()
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

  test('pins a comment to a CSV cell and focuses feedback in a narrow composer without sending', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    await page.evaluate(() => localStorage.setItem('tray_drawer_width', '700'))

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

    // Submitting moves the formatted feedback into the composer for review. It
    // must not POST a message until the user explicitly sends from there.
    const userMessageCount = await sessionPage.getUserMessages().count()
    let feedbackPostCount = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(request.url())) {
        feedbackPostCount += 1
      }
    })

    await tray.getByRole('button', { name: 'Submit' }).click()

    const composer = sessionPage.getMessageInput()
    await expect(composer).toContainText('File feedback on data.csv:')
    await expect(composer).toContainText('At cell 1:Email (col 2, value: "alice@example.com"):')
    await expect(composer).toContainText('This email looks wrong')
    await expect(composer).toBeFocused()
    await expect(sessionPage.getUserMessages()).toHaveCount(userMessageCount)
    expect(feedbackPostCount).toBe(0)
  })

  test('renders a video and pins a timestamped comment via the Add Comment button', async ({ page }) => {
    await agentPage.createAgent(`VideoComment ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    // A handful of bytes is enough: the comment flow keys off the default frame
    // (timestamp 0) and never depends on the file actually decoding.
    seedWorkspaceFile(agentSlug, 'output/clip.mp4', Buffer.from('00000018667479706d70343200000000', 'hex'))

    await sessionPage.sendMessage('deliver video')
    await sessionPage.waitForResponse(15000)

    const filePill = getFilePill(page, 'clip.mp4').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('video-renderer')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('video-element')).toBeVisible()

    // The Add Comment button opens the editor directly and pins the timestamp.
    await page.getByTestId('video-add-comment').click()
    const overlay = page.locator('[data-comment-overlay]')
    await expect(overlay.getByText('At 0:00', { exact: false })).toBeVisible({ timeout: 5000 })

    await page.getByPlaceholder('Add your comment...').fill('Trim the intro here')
    await overlay.getByRole('button', { name: 'Add' }).click()

    // The comment bar lists the timestamped comment.
    const tray = page.getByTestId('file-preview-tray')
    await expect(tray.getByText('At 0:00', { exact: false })).toBeVisible({ timeout: 5000 })
    await expect(tray.getByText('Trim the intro here')).toBeVisible()

    // The video feedback follows the same review-before-send flow.
    await tray.getByRole('button', { name: 'Submit' }).click()
    const composer = sessionPage.getMessageInput()
    await expect(composer).toContainText('File feedback on clip.mp4:')
    await expect(composer).toContainText('At 0:00 at position (50%, 50%):')
    await expect(composer).toContainText('Trim the intro here')
  })

  test('renders an audio waveform and adds a timestamped comment from its hover affordance', async ({ page }) => {
    await agentPage.createAgent(`AudioComment ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    // Rendering and annotation do not depend on successful decoding; the player
    // retains a useful fallback waveform for unsupported or incomplete audio.
    seedWorkspaceFile(agentSlug, 'output/voice-note.mp3', Buffer.from('49443304000000000000', 'hex'))

    await sessionPage.sendMessage('deliver audio')
    await sessionPage.waitForResponse(15000)

    const filePill = getFilePill(page, 'voice-note.mp3').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    const audioRenderer = page.getByTestId('audio-renderer')
    await expect(audioRenderer).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('audio-element')).toBeAttached()
    await expect(page.getByTestId('audio-waveform')).toBeVisible()
    await expect(page.getByTestId('audio-add-comment')).toBeVisible()

    await page.getByTestId('audio-waveform').hover({ position: { x: 160, y: 56 } })
    const hoverComment = page.getByTestId('audio-hover-add-comment')
    await expect(hoverComment).toBeVisible()
    await hoverComment.click()

    const overlay = page.locator('[data-comment-overlay]')
    await expect(overlay.getByText('At 0:00', { exact: false })).toBeVisible({ timeout: 5000 })
    await page.getByPlaceholder('Add your comment...').fill('Remove this background noise')
    await overlay.getByRole('button', { name: 'Add' }).click()

    const tray = page.getByTestId('file-preview-tray')
    await expect(tray.getByText('At 0:00', { exact: false })).toBeVisible({ timeout: 5000 })
    await expect(tray.getByText('Remove this background noise')).toBeVisible()

    await tray.getByRole('button', { name: 'Submit' }).click()
    await expect(page.getByText('Remove this background noise').first()).toBeVisible({ timeout: 10000 })
  })

  test.describe('narrow window', () => {
    test.use({ viewport: { width: 800, height: 700 } })

    test('header controls stay on-screen when the stored drawer width exceeds the window', async ({ page }) => {
      // Persisted drawer width wider than the window used to push the drawer
      // past the right viewport edge, clipping the download/close buttons.
      await page.addInitScript(() => localStorage.setItem('tray_drawer_width', '800'))
      await appPage.goto()
      await appPage.waitForAgentsLoaded()

      await agentPage.createAgent(`NarrowTray ${Date.now()}`)
      const agentSlug = await getLatestAgentSlug(page)
      seedWorkspaceFile(agentSlug, 'output/report.md', '# Report')

      await sessionPage.sendMessage('deliver file')
      await sessionPage.waitForResponse(15000)

      const filePill = getFilePill(page, 'report.md').first()
      await expect(filePill).toBeVisible({ timeout: 10000 })
      await filePill.click()

      const header = page.getByTestId('file-preview-header')
      await expect(header).toBeVisible({ timeout: 5000 })

      // Poll while the full-width tray slides in. Compact mode replaces the
      // right-side panel control with a left-side close button.
      const viewportWidth = page.viewportSize()!.width
      await expect(async () => {
        for (const control of [header.getByTitle('Close file preview'), header.getByTitle('Download file')]) {
          await expect(control).toBeVisible()
          const box = await control.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth)
        }
      }).toPass({ timeout: 5000 })
    })
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

    // The overlay covers the composer by design, so close it before delivering
    // the next file. Existing tabs remain available when the tray reopens.
    await page.getByRole('button', { name: 'Hide files panel' }).click()

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
