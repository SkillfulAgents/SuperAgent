import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { mockSpeech } from '../helpers/speech'

const e2eDataDir = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')

function getDeliveredFileRow(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('file-delivery-row').filter({ hasText: fileName })
}

function markdown(page: import('@playwright/test').Page) {
  return page.getByTestId('markdown-renderer')
}

function fileTab(page: import('@playwright/test').Page, fileName: string) {
  return page.getByTestId('file-tab').filter({ hasText: fileName })
}

async function rightEdge(locator: import('@playwright/test').Locator): Promise<number> {
  const box = (await locator.boundingBox())!
  return Math.round(box.x + box.width)
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

  test('file delivery shows a row and opens preview on click', async ({ page }) => {
    await agentPage.createAgent(`FilePreview ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Test Report\n\nThis is a test with **bold** text.')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const filePill = getDeliveredFileRow(page, 'report.md').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })

    await filePill.click()

    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByRole('heading', { name: 'Test Report' })).toBeVisible({ timeout: 10000 })

    // On a wide Session View, the preview participates in the row layout rather
    // than covering the chat and composer.
    await expect.poll(async () => {
      const [sessionBox, drawerBox] = await Promise.all([
        page.getByTestId('session-thread-main').boundingBox(),
        page.getByTestId('tray-drawer').boundingBox(),
      ])
      if (!sessionBox || !drawerBox) return Number.POSITIVE_INFINITY
      return Math.abs(sessionBox.x + sessionBox.width - drawerBox.x)
    }).toBeLessThanOrEqual(1)
  })

  test('agent home bookmark preview overlays the wide page', async ({ page }) => {
    await agentPage.createAgent(`HomeFilePreview ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'reports/daily.md', '# Daily Report')

    const bookmarksResponse = await page.request.put(`/api/agents/${agentSlug}/bookmarks`, {
      data: [{ name: 'Daily report', file: '/workspace/reports/daily.md' }],
    })
    expect(bookmarksResponse.ok()).toBeTruthy()

    await page.reload()
    const bookmark = page.getByRole('button', { name: 'Daily report' })
    await expect(bookmark).toBeVisible({ timeout: 10000 })
    await bookmark.click()
    await expect(markdown(page).getByRole('heading', { name: 'Daily Report' })).toBeVisible({ timeout: 10000 })

    const homeBox = await page.getByTestId('agent-home').boundingBox()
    const drawerBox = await page.getByTestId('tray-drawer').boundingBox()
    expect(homeBox).not.toBeNull()
    expect(drawerBox).not.toBeNull()
    expect(Math.abs(homeBox!.x + homeBox!.width - (drawerBox!.x + drawerBox!.width))).toBeLessThanOrEqual(1)
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

    const filePill = getDeliveredFileRow(page, 'report.md').first()
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

    const firstPill = getDeliveredFileRow(page, 'report.md').first()
    await expect(firstPill).toBeVisible({ timeout: 10000 })
    await firstPill.click()

    await expect(markdown(page).getByRole('heading', { name: 'Version 1' })).toBeVisible({ timeout: 10000 })

    // The wide Session View remains usable while the split preview is open.
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Version 2')
    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)

    const secondPill = getDeliveredFileRow(page, 'report.md').nth(1)
    await expect(secondPill).toBeVisible({ timeout: 10000 })
    await secondPill.click()

    await expect(markdown(page).getByRole('heading', { name: 'Version 2' })).toBeVisible({ timeout: 10000 })
  })

  test('an open file reloads when the agent edits it', async ({ page }) => {
    await agentPage.createAgent(`FileReload ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Report\n\nKept line.\n\nOld line.\n')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)
    await getDeliveredFileRow(page, 'report.md').first().click()
    await expect(markdown(page).getByText('Old line.')).toBeVisible({ timeout: 10000 })

    // The mock holds the reply open for 8s after the Edit's result, so the new text
    // arriving inside 5s comes from the tool result, not from the reply ending.
    await sessionPage.sendMessage('edit report')
    await expect(markdown(page).getByText('New line.')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByText('Old line.')).toHaveCount(0)
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

    const filePill = getDeliveredFileRow(page, 'data.csv').first()
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

    const filePill = getDeliveredFileRow(page, 'data.csv').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    const csv = page.getByTestId('csv-renderer')
    await expect(csv).toBeVisible({ timeout: 10000 })

    // Near the pane's right edge, the Comment button and the editor it opens both
    // slide left to end 8px inside the pane. At 800px the drawer is the compact overlay
    // and slides in with a transform, so wait for its left edge to land.
    const containerX = (await page.getByTestId('file-preview-container').boundingBox())!.x
    await expect.poll(async () => (await page.getByTestId('tray-drawer').boundingBox())?.x).toBe(containerX)
    const overlay = page.locator('[data-comment-overlay]')
    const paneRight = await rightEdge(csv)
    await csv.getByRole('cell', { name: '30', exact: true }).click()
    await expect(overlay).toBeVisible()
    expect(await rightEdge(overlay)).toBe(paneRight - 8)
    // Moved to a cell with room, the open button follows the click and stops shifting.
    const aliceBox = (await csv.getByRole('cell', { name: 'alice@example.com' }).boundingBox())!
    const aliceX = Math.round(aliceBox.x + aliceBox.width / 2)
    await page.mouse.click(aliceX, aliceBox.y + aliceBox.height / 2)
    await expect.poll(async () => Math.round((await overlay.boundingBox())!.x)).toBe(aliceX)
    await csv.getByRole('cell', { name: '30', exact: true }).click()
    await overlay.getByRole('button', { name: 'Comment' }).click()
    await expect(page.getByPlaceholder('Add your comment...')).toBeVisible()
    expect(await rightEdge(overlay)).toBe(paneRight - 8)
    await overlay.getByRole('button', { name: 'Cancel' }).click()

    // Click a data cell → comment affordance appears.
    await csv.getByRole('cell', { name: 'alice@example.com' }).click()
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

  test('a composer squeezed by the preview keeps its toolbar buttons apart in a wide window', async ({ page }) => {
    // Wide enough that the preview sits beside the chat, not over it.
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.evaluate(() => localStorage.setItem('tray_drawer_width', '400'))
    // Voice configured, so the row carries the voice-mode button as it does for users who set it up.
    // Without it the left group is ~40px wider and the label stage would pass a cutoff that
    // collapses the picker for those users.
    await page.route('**/api/voice/configured', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true, supportsTts: true }) }),
    )
    // The app already loaded in beforeEach; reload so no cached voice status predates the route.
    await appPage.reload()

    await agentPage.createAgent(`ComposerSqueeze ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Report')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)
    await getDeliveredFileRow(page, 'report.md').first().click()
    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })

    const toolbar = async () => {
      const [attachBox, pickerBox, sendBox] = await Promise.all([
        page.getByRole('button', { name: 'Add files' }).boundingBox(),
        page.getByTestId('composer-options-trigger').boundingBox(),
        page.getByTestId('send-button').boundingBox(),
      ])
      return {
        pickerWidth: pickerBox?.width,
        labelShown: (pickerBox?.width ?? 0) > 34,
        sendBelowAttach: !!attachBox && !!sendBox && sendBox.y >= attachBox.y + attachBox.height,
      }
    }
    const drawerWidth = async () => (await page.getByTestId('tray-drawer').boundingBox())?.width

    // The chat is narrower than the window, but the row still leaves the picker room for its label.
    await expect(page.getByTestId('voice-mode-button')).toBeVisible()
    await expect.poll(drawerWidth).toBe(400)
    await expect.poll(toolbar).toMatchObject({ labelShown: true, sendBelowAttach: false })

    // Squeezed further, the drawer slides over the chat at 240px. The right-hand buttons wrap
    // to their own line, leaving the picker enough room to keep its label.
    await page.evaluate(() => localStorage.setItem('tray_drawer_width', '620'))
    await appPage.reload()
    await getDeliveredFileRow(page, 'report.md').first().click()
    await expect.poll(drawerWidth).toBe(620)
    await expect.poll(async () => (await page.getByTestId('session-thread-main').boundingBox())?.width).toBe(240)
    await expect.poll(toolbar).toMatchObject({ labelShown: true, sendBelowAttach: true })
  })

  test('renders a video and pins a timestamped comment via the Add Comment button', async ({ page }) => {
    await agentPage.createAgent(`VideoComment ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    // A handful of bytes is enough: the comment flow keys off the default frame
    // (timestamp 0) and never depends on the file actually decoding.
    seedWorkspaceFile(agentSlug, 'output/clip.mp4', Buffer.from('00000018667479706d70343200000000', 'hex'))

    await sessionPage.sendMessage('deliver video')
    await sessionPage.waitForResponse(15000)

    const filePill = getDeliveredFileRow(page, 'clip.mp4').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()

    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('video-renderer')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('video-element')).toBeVisible()

    // The editor fits itself to the pane as it opens, so let the drawer finish sliding in.
    // 450 is the default width. Its pane is too narrow for an editor centred on the
    // 300px frame.
    await expect.poll(async () => (await page.getByTestId('tray-drawer').boundingBox())?.width).toBe(450)
    const overlay = page.locator('[data-comment-overlay]')

    // Opened near the frame's left edge, the editor fits and stays at the click.
    const frameBox = (await page.getByTestId('video-element').boundingBox())!
    const clickX = Math.round(frameBox.x + 5)
    await page.mouse.click(clickX, frameBox.y + frameBox.height / 2)
    await expect(overlay).toBeVisible()
    expect(Math.round((await overlay.boundingBox())!.x)).toBe(clickX)
    await overlay.getByRole('button', { name: 'Cancel' }).click()

    // The Add Comment button opens the editor directly and pins the timestamp.
    await page.getByTestId('video-add-comment').click()
    await expect(overlay.getByText('At 0:00.00', { exact: false })).toBeVisible({ timeout: 5000 })
    // The undecoded clip keeps the default 300px frame, so the editor at its centre
    // would run past the pane. It slides left to end 8px inside the pane instead.
    expect(await rightEdge(overlay)).toBe(await rightEdge(page.getByTestId('video-renderer')) - 8)

    await page.getByPlaceholder('Add your comment...').fill('Trim the intro here')
    await overlay.getByRole('button', { name: 'Add' }).click()

    // The comment bar lists the timestamped comment.
    const tray = page.getByTestId('file-preview-tray')
    await expect(tray.getByText('At 0:00.00', { exact: false })).toBeVisible({ timeout: 5000 })
    await expect(tray.getByText('Trim the intro here')).toBeVisible()
    // The scrubber markers render once the video reports a duration; the fixture can't decode, so report one.
    await page.getByTestId('video-element').evaluate((v: HTMLVideoElement) => {
      Object.defineProperty(v, 'duration', { configurable: true, value: 8 })
      v.dispatchEvent(new Event('loadedmetadata'))
    })
    await expect(page.getByTitle('Comment at 0:00.00')).toBeAttached()

    // The video feedback follows the same review-before-send flow.
    await tray.getByRole('button', { name: 'Submit' }).click()
    const composer = sessionPage.getMessageInput()
    await expect(composer).toContainText('File feedback on clip.mp4:')
    await expect(composer).toContainText('At 0:00.00 at position (50%, 50%):')
    await expect(composer).toContainText('Trim the intro here')
  })

  test('M opens a video comment already listening, and Enter adds what was said', async ({ page }) => {
    const speech = await mockSpeech(page, { supportsTts: false })
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`VideoVoiceComment ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/clip.mp4', Buffer.from('00000018667479706d70343200000000', 'hex'))

    await sessionPage.sendMessage('deliver video')
    await sessionPage.waitForResponse(15000)
    await getDeliveredFileRow(page, 'clip.mp4').first().click()
    await page.getByTestId('video-renderer').click({ position: { x: 5, y: 5 } })

    await page.keyboard.press('m')
    const overlay = page.locator('[data-comment-overlay]')
    await expect(overlay.getByRole('button', { name: 'Stop recording' })).toBeVisible({ timeout: 10000 })
    await expect.poll(() => speech.listen()).not.toBeNull()
    speech.hear('Trim the intro')
    const box = page.getByPlaceholder('Add your comment...')
    await expect(box).toHaveValue('Trim the intro')

    // Enter waits for the words still in flight when the mic stops.
    speech.hearOnClose('Trim the intro here')
    await box.press('Enter')
    await expect(overlay).toHaveCount(0)
    await expect(page.getByTestId('file-preview-tray').getByText('Trim the intro here')).toBeVisible()

    // Cancel while recording releases the mic.
    await page.keyboard.press('m')
    await expect.poll(() => speech.micLive()).toBe(true)
    await overlay.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(() => speech.micLive()).toBe(false)
    await expect.poll(() => speech.listen()).toBeNull()
  })

  test('renders an audio waveform and adds a timestamped comment from its hover affordance', async ({ page }) => {
    await agentPage.createAgent(`AudioComment ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    // Rendering and annotation do not depend on successful decoding; the player
    // retains a useful fallback waveform for unsupported or incomplete audio.
    seedWorkspaceFile(agentSlug, 'output/voice-note.mp3', Buffer.from('49443304000000000000', 'hex'))

    await sessionPage.sendMessage('deliver audio')
    await sessionPage.waitForResponse(15000)

    const filePill = getDeliveredFileRow(page, 'voice-note.mp3').first()
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
    await expect(overlay.getByText('At 0:00.00', { exact: false })).toBeVisible({ timeout: 5000 })
    await page.getByPlaceholder('Add your comment...').fill('Remove this background noise')
    await overlay.getByRole('button', { name: 'Add' }).click()

    const tray = page.getByTestId('file-preview-tray')
    await expect(tray.getByText('At 0:00.00', { exact: false })).toBeVisible({ timeout: 5000 })
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

      const filePill = getDeliveredFileRow(page, 'report.md').first()
      await expect(filePill).toBeVisible({ timeout: 10000 })
      await filePill.click()

      const header = page.getByTestId('file-preview-header')
      await expect(header).toBeVisible({ timeout: 5000 })
      // The compact overlay covers the chat outright, so the slide-over dim stays hidden.
      await expect(page.getByTestId('tray-drawer-scrim')).toHaveCSS('display', 'none')

      // Poll while the full-width tray slides in. Compact mode replaces the
      // right-side panel control with a left-side close button.
      const viewportWidth = page.viewportSize()!.width
      await expect(async () => {
        const title = page.getByTestId('file-preview-title')
        for (const control of [header.getByTitle('Close file preview'), title.getByLabel('Download file')]) {
          await expect(control).toBeVisible()
          const box = await control.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth)
        }
      }).toPass({ timeout: 5000 })

      const containerBox = await page.getByTestId('file-preview-container').boundingBox()
      const drawerBox = await page.getByTestId('tray-drawer').boundingBox()
      expect(containerBox).not.toBeNull()
      expect(drawerBox).not.toBeNull()
      expect(Math.abs(drawerBox!.x - containerBox!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(drawerBox!.width - containerBox!.width)).toBeLessThanOrEqual(1)
    })
  })

  test.describe('drawer wider than the chat can spare', () => {
    // Wide enough that the drawer sits beside the chat, narrow enough that 800px of it leaves the chat ~100px.
    test.use({ viewport: { width: 1200, height: 760 } })
    // The rewritten responses below can still be in flight as a test ends; let them go instead of failing it.
    test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }))

    /** A new agent's delivered file, open in a drawer that leaves the chat 250px: past the reload, so the turn is not recent activity. */
    async function openFileBesideNarrowChat(page: import('@playwright/test').Page, name: string, drawerWidth = 654, chatWidth = 250) {
      await agentPage.createAgent(`${name} ${Date.now()}`)
      seedWorkspaceFile(await getLatestAgentSlug(page), 'output/report.md', '# Report')
      await sessionPage.sendMessage('deliver file')
      await sessionPage.waitForResponse(15000)
      await page.evaluate((width) => localStorage.setItem('tray_drawer_width', String(width)), drawerWidth)
      await page.reload()
      await getDeliveredFileRow(page, 'report.md').first().click()
      await expect.poll(async () => Math.round((await page.getByTestId('session-thread-main').boundingBox())!.width)).toBe(chatWidth)
    }

    /**
     * The mock never idles a session, schedules a wake, or reports a turn's length and tokens, so the rows these
     * show come from rewritten responses: a long idle with a full context and a pending wake, and a 2m 14s turn.
     */
    async function fakeLongRealSession(page: import('@playwright/test').Page) {
      await page.route(/\/api\/agents\/[^/]+\/sessions\/[^/?]+(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const response = await route.fetch()
        const session = await response.json()
        session.lastActivityAt = new Date(Date.now() - 7 * 3600_000).toISOString()
        session.lastUsage = { inputTokens: 150_000, outputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, contextWindow: 200_000 }
        session.pendingWakeAt = new Date(Date.now() + 3 * 3600_000).toISOString()
        session.pendingWakeTaskId = 'task-wake'
        // A long note, so the banner's two-line limit is what holds when it resumes in view.
        session.pendingWakeNote = 'Check whether the review has been approved and the release notes are ready to send'
        await route.fulfill({ response, json: session })
      })
      await page.route(/\/api\/agents\/[^/]+\/sessions\/[^/]+\/messages(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const response = await route.fetch()
        const body = await response.json()
        // A delta with nothing new carries no page to rewrite.
        if (!Array.isArray(body?.messages) || body.messages.length === 0) return route.fulfill({ response, json: body })
        const start = new Date(body.messages[0].createdAt).getTime()
        for (const message of body.messages.filter((m: { type?: unknown }) => m.type === 'assistant')) {
          message.usage = { inputTokens: 360_000, outputTokens: 8_541, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
          message.createdAt = new Date(start + 134_000).toISOString()
        }
        await route.fulfill({ response, json: body })
      })
    }

    test('the drawer slides over the chat instead of squeezing it, and Download keeps only its icon', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('tray_drawer_width', '800'))
      await appPage.goto()
      await appPage.waitForAgentsLoaded()

      await agentPage.createAgent(`SlideOver ${Date.now()}`)
      const agentSlug = await getLatestAgentSlug(page)
      seedWorkspaceFile(agentSlug, 'output/report.md', '# Report')
      seedWorkspaceFile(agentSlug, 'output/bundle.zip', Buffer.alloc(64))

      await sessionPage.sendMessage('deliver archive')
      await sessionPage.waitForResponse(15000)
      await sessionPage.sendMessage('deliver file')
      await sessionPage.waitForResponse(15000)
      const downloadLabel = getDeliveredFileRow(page, 'bundle.zip').getByText('Download', { exact: true })
      await expect(downloadLabel).toBeVisible()
      await getDeliveredFileRow(page, 'report.md').first().click()

      // The drawer keeps its full width and the chat keeps 240px under it, rather than either giving way.
      const chat = page.getByTestId('session-thread-main')
      await expect(async () => {
        expect(Math.round((await chat.boundingBox())!.width)).toBe(240)
        expect(Math.round((await page.getByTestId('tray-drawer').boundingBox())!.width)).toBe(800)
      }).toPass({ timeout: 5000 })
      // Over the z-20 composer footer: the dim takes clicks in the strip the drawer leaves uncovered, and the drawer
      // paints above both where it overlaps the chat.
      const chatBox = (await chat.boundingBox())!
      const drawerBox = (await page.getByTestId('tray-drawer').boundingBox())!
      const y = chatBox.y + chatBox.height - 20
      const hit = (x: number) => page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py)
        return el?.closest('[data-testid="tray-drawer"]') ? 'tray-drawer' : (el as HTMLElement | null)?.dataset.testid
      }, [x, y])
      expect(await hit(chatBox.x + 8)).toBe('tray-drawer-scrim')
      expect(await hit((drawerBox.x + chatBox.x + chatBox.width) / 2)).toBe('tray-drawer')
      await expect(downloadLabel).toBeHidden()
    })

    test('the rows around the composer rearrange in the chat a drawer leaves, instead of squeezing their text', async ({ page }) => {
      await fakeLongRealSession(page)

      await openFileBesideNarrowChat(page, 'Rows')
      await expect(page.getByTestId('stale-toast-card')).toBeVisible({ timeout: 15000 })

      // The rows can still be settling into place, so measure until the layout holds.
      await expect(async () => {
        const rows = await page.evaluate(() => {
          const box = (el: Element) => el.getBoundingClientRect()
          const lines = (el: Element) => Math.round(box(el).height / parseFloat(getComputedStyle(el).lineHeight))
          // Text leaves only: a wrapper's inherited line height is not its text's, so it misreads a wrap.
          const leaves = (root: Element) => [...root.querySelectorAll('span')].filter((s) => !s.children.length && s.textContent!.trim().length > 1)
          const notice = document.querySelector('[data-testid="stale-toast-card"]')!
          const noticeText = notice.querySelector('p')!.parentElement!
          const noticeButtons = [...notice.querySelectorAll('[data-testid="stale-toast-ignore"], [data-testid="stale-options-trigger"]')]
          const banner = document.querySelector('[data-testid="pending-wake-banner"]')!
          const deadline = banner.querySelector('[title]')!
          const summary = document.querySelector('[data-testid="turn-summary"]')!
          const footer = document.querySelector('kbd')!.closest('.isolate')!
          return {
            noticeText: Math.round(box(noticeText).width),
            noticeButtonsPastCard: Math.max(...noticeButtons.map((b) => Math.round(box(b).right - box(notice).right))),
            deadlineInsideBanner: box(deadline).right <= box(banner).right && box(deadline).bottom <= box(banner).bottom,
            deadlineWidth: Math.round(box(deadline).width),
            summaryPieceLines: leaves(summary).map(lines),
            footerTextLines: leaves(footer).map(lines),
            footerOverflow: footer.scrollWidth - footer.clientWidth,
            wakeMessageLines: lines(deadline.parentElement!),
            // The key hint, wrapped under Context Usage, starts at the same left edge.
            hint: (() => {
              const [context, hint] = [...footer.children].filter((c) => c.textContent!.trim()).map((c) => box(c))
              return { wrapped: hint.top >= context.bottom, leftOffset: Math.round(Math.abs(hint.left - context.left)) }
            })(),
          }
        })
        // The notice keeps its text readable (10rem) and its buttons inside the card, rather than the reverse.
        expect(rows.noticeText).toBeGreaterThanOrEqual(160)
        expect(rows.noticeButtonsPastCard).toBeLessThanOrEqual(0)
        // The banner keeps when it resumes, instead of truncating the message down to its icon.
        expect(rows.deadlineInsideBanner).toBe(true)
        expect(rows.deadlineWidth).toBeGreaterThan(0)
        // The summary and the footer wrap between their pieces, never inside one.
        expect(rows.summaryPieceLines).toEqual([1, 1, 1])
        expect(rows.footerTextLines).toEqual([1, 1, 1])
        expect(rows.footerOverflow).toBeLessThanOrEqual(0)
        expect(rows.hint.wrapped).toBe(true)
        expect(rows.hint.leftOffset).toBeLessThanOrEqual(1)
        // A long note is cut at two lines instead of growing the banner.
        expect(rows.wakeMessageLines).toBe(2)
      }).toPass({ timeout: 10000 })
    })

    test('the notice keeps its buttons beside its text while the chat can spare them its readable width', async ({ page }) => {
      await fakeLongRealSession(page)
      // A 504px chat: wide enough for 10rem of text beside the buttons, too narrow for the whole sentence beside them.
      await openFileBesideNarrowChat(page, 'Beside', 400, 504)
      await expect(async () => {
        const besideText = await page.getByTestId('stale-toast-card').evaluate((card) =>
          card.lastElementChild!.getBoundingClientRect().top < card.firstElementChild!.getBoundingClientRect().bottom)
        expect(besideText).toBe(true)
      }).toPass({ timeout: 10000 })
    })

    // The mock cannot connect a server or an account, so their lists answer with one at the requested address.
    const connectedServer = { id: 'mcp-connected', name: 'Linear Workspace Tools', url: 'http://localhost:9876/mcp', authType: 'none', status: 'active', errorMessage: null, tools: [] }
    const connectedAccount = { id: 'acct-connected', toolkitSlug: 'github', displayName: 'work-github-account', status: 'active', createdAt: new Date().toISOString() }
    const cards: Array<{ title: string; trigger: string; card: string; names: string[]; servers?: object[]; accounts?: object[]; reconnect?: boolean }> = [
      { title: 'an MCP request with two connected servers to pick from', trigger: 'request mcp', card: 'remote-mcp-request', names: [connectedServer.name, 'Linear Personal', 'Not the right MCP?'], servers: [connectedServer, { ...connectedServer, id: 'mcp-connected-2', name: 'Linear Personal' }] },
      { title: 'an account request with an account that needs reconnecting', trigger: 'ask account', card: 'connected-account-request', names: [connectedAccount.displayName], accounts: [{ ...connectedAccount, status: 'expired' }], reconnect: true },
    ]
    for (const { title, trigger, card, names, servers, accounts, reconnect } of cards) {
      test(`${title} card keeps its buttons and names inside it in the chat a drawer leaves`, async ({ page }) => {
        if (servers) {
          await page.route(/\/api\/remote-mcps(\?.*)?$/, (route) =>
            route.request().method() === 'GET' ? route.fulfill({ json: { servers } }) : route.continue())
        }
        if (accounts) {
          await page.route(/\/api\/connected-accounts(\?.*)?$/, (route) =>
            route.request().method() === 'GET' ? route.fulfill({ json: { accounts } }) : route.continue())
        }
        await openFileBesideNarrowChat(page, 'Card')
        await sessionPage.sendMessage(trigger)
        await expect(page.getByTestId(card)).toBeVisible({ timeout: 15000 })
        if (reconnect) await expect(page.getByTestId(card).getByRole('button', { name: /reconnect/i }).first()).toBeVisible()
        await expect(page.getByTestId(card).getByTestId('request-stop-session')).toBeVisible()

        // The card can still be settling into place, so measure until the layout holds.
        await expect(async () => {
          const geometry = await page.getByTestId(card).evaluate((el, names) => {
            // An action-row button must stay inside the row itself, not just the card: the footer's padding is the card's edge too.
            const past = (b: Element) => {
              const actions = b.closest('[data-request-item-actions]')
              const row = actions?.getAttribute('data-request-item-actions') === 'footer' ? actions.firstElementChild : actions
              const box = (row ?? el).getBoundingClientRect()
              const r = b.getBoundingClientRect()
              return r.width > 0 ? Math.round(Math.max(r.right - box.right, box.left - r.left)) : -Infinity
            }
            // Each named text's width, against what it needs on one line (a squeezed text wraps, so its own scrollWidth hides that).
            const texts = names.map((name) => {
              const node = [...el.querySelectorAll<HTMLElement>('*')].find((n) => !n.children.length && n.textContent?.trim() === name)
              if (!node) return { name, width: 0, needs: 1, lines: 0 }
              const { width, height } = node.getBoundingClientRect()
              node.style.whiteSpace = 'nowrap'
              const needs = node.scrollWidth
              node.style.whiteSpace = ''
              return { name, width: Math.round(width), needs, lines: Math.round(height / parseFloat(getComputedStyle(node).lineHeight)) }
            })
            // A checkbox stays on the line with the server or account it selects, not stranded above it.
            const strandedCheckboxes = [...el.querySelectorAll('input[type="checkbox"]')].filter((box) => {
              const name = box.closest('[role="button"]')?.querySelector('.truncate')
              return name && box.getBoundingClientRect().bottom <= name.getBoundingClientRect().top
            }).length
            // A single card's close button stays on its title's line; only a stack's paging moves above the title.
            const title = el.querySelector('[data-request-item-body]')!.firstElementChild!.firstElementChild!.firstElementChild!.getBoundingClientRect()
            const close = el.querySelector('[data-testid="request-stop-session"]')!.getBoundingClientRect()
            const closeBesideTitle = close.top < title.bottom && close.bottom > title.top
            return { buttonsPastCard: Math.max(...[...el.querySelectorAll('button')].map(past)), texts, strandedCheckboxes, closeBesideTitle }
          }, names)
          expect(geometry.strandedCheckboxes).toBe(0)
          expect(geometry.closeBesideTitle).toBe(true)
          // Every button stays reachable inside the card, and each name stays readable on one line: all of it, or 48px of a long one.
          expect(geometry.buttonsPastCard).toBeLessThanOrEqual(0)
          for (const text of geometry.texts) {
            expect(text.lines, text.name).toBe(1)
            expect(text.width, text.name).toBeGreaterThanOrEqual(Math.min(48, text.needs))
          }
        }).toPass({ timeout: 10000 })
      })
    }

    test('a stacked request card moves its paging above the title in the chat a drawer leaves', async ({ page }) => {
      await openFileBesideNarrowChat(page, 'Stack')
      await sessionPage.sendMessage('ask parallel')
      const paging = page.locator('[data-testid="request-stack-pagination"]:visible').first()
      await expect(paging).toBeVisible({ timeout: 15000 })

      // The card can still be settling into place, so measure until the layout holds.
      await expect(async () => {
        const header = await paging.evaluate((el) => {
          const row = el.closest('[data-request-item-body]')!.firstElementChild!.firstElementChild!
          const title = row.firstElementChild!.getBoundingClientRect()
          const controls = row.lastElementChild!.getBoundingClientRect()
          return controls.bottom <= title.top
        })
        // The paging and close button take their own line above the title.
        expect(header).toBe(true)
      }).toPass({ timeout: 10000 })
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
    const reportPill = getDeliveredFileRow(page, 'report.md').first()
    await expect(reportPill).toBeVisible({ timeout: 10000 })
    await reportPill.click()
    await expect(page.getByTestId('file-preview-header')).toBeVisible({ timeout: 5000 })
    await expect(markdown(page).getByRole('heading', { name: 'Report Content' })).toBeVisible({ timeout: 10000 })

    // Deliver while the split preview remains open, then open the image file →
    // second tab, image renderer.
    await sessionPage.sendMessage('deliver image')
    await sessionPage.waitForResponse(15000)
    const chartPill = getDeliveredFileRow(page, 'chart.png').first()
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

    await expect(page.getByTestId('file-preview-copy')).toBeVisible()

    // Switch forward to the image tab again → image renderer returns.
    await fileTab(page, 'chart.png').click()
    await expect(page.locator('img[alt="chart.png"]')).toBeVisible({ timeout: 5000 })

    // A PNG has nothing copyable, so the header drops the action.
    await expect(page.getByTestId('file-preview-copy')).toHaveCount(0)
  })

  test('copies the open text file from the title row', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await agentPage.createAgent(`CopyFile ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedWorkspaceFile(agentSlug, 'output/report.md', '# Test Report\n\nThis is a test with **bold** text.')

    await sessionPage.sendMessage('deliver file')
    await sessionPage.waitForResponse(15000)
    const filePill = getDeliveredFileRow(page, 'report.md').first()
    await expect(filePill).toBeVisible({ timeout: 10000 })
    await filePill.click()
    await expect(markdown(page).getByRole('heading', { name: 'Test Report' })).toBeVisible({ timeout: 10000 })

    // The per-file actions live with the filename, not in the panel header.
    const titleRow = page.getByTestId('file-preview-title')
    await titleRow.getByTestId('file-preview-copy').click()

    // The real gate: a browser only honours the write while the click's user
    // gesture is live, so this fails if the handler awaits a fetch first.
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('# Test Report\n\nThis is a test with **bold** text.')

    await expect(page.getByText('Copied contents of “report.md”')).toBeVisible()
    await expect(titleRow.getByTestId('file-preview-copied-icon')).toBeVisible()
    await expect(titleRow.getByTestId('file-preview-copy-icon')).toBeVisible({ timeout: 5000 })
  })
})
