import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Q3 Revenue</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; background: #f8fafc; color: #0f172a; }
    h1 { margin: 0 0 24px; font-size: 22px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; }
    .card h2 { margin: 0 0 8px; font-size: 13px; color: #64748b; font-weight: 500; }
    .value { font-size: 28px; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Q3 revenue by region</h1>
  <main class="grid">
    <div class="card" id="emea"><h2>EMEA</h2><span class="value" data-testid="emea-value">$1.2M</span></div>
    <div class="card" id="amer"><h2>Americas</h2><span class="value">$2.4M</span></div>
    <div class="card" id="apac"><h2>APAC</h2><span class="value">$0.9M</span></div>
  </main>
  <script>
    console.log('dashboard ready');
    console.error('Chart failed: series is undefined');
  </script>
</body>
</html>`

/** A dashboard the mock container reports as running and serves as-is. */
function seedDashboard(agentSlug: string) {
  const dataDir = process.env.SUPERAGENT_DATA_DIR
  if (!dataDir) throw new Error('SUPERAGENT_DATA_DIR is required for dashboard seeding')
  const dashboardDir = path.join(dataDir, 'agents', agentSlug, 'workspace', 'artifacts', 'revenue')
  fs.mkdirSync(dashboardDir, { recursive: true })
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), JSON.stringify({ name: 'Q3 Revenue', version: '1.0.0' }))
  fs.writeFileSync(path.join(dashboardDir, 'index.html'), DASHBOARD_HTML)
}

async function openDashboard(page: Page, agentSlug: string) {
  await page.goto(`/agents/${agentSlug}/dashboards/revenue`)
  const frame = page.frameLocator('iframe')
  await expect(frame.getByTestId('emea-value')).toBeVisible({ timeout: 20_000 })
  // The inspector is injected ahead of the page's own scripts.
  await expect.poll(async () => page.frames().some((f) => f.url().includes('/artifacts/revenue'))).toBe(true)
  return frame
}

/** The message the new session was created with. */
function nextSessionMessage(page: Page, agentSlug: string): Promise<string> {
  return page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === `/api/agents/${agentSlug}/sessions`,
  ).then((request) => (request.postDataJSON() as { message: string }).message)
}

test.describe('dashboard comments', () => {
  let agentSlug: string

  test.beforeEach(async ({ page }) => {
    const created = await page.request.post('/api/agents', { data: { name: `comments-e2e-${Date.now()}` } })
    agentSlug = (await created.json() as { slug: string }).slug
    seedDashboard(agentSlug)
    await page.request.post(`/api/agents/${agentSlug}/start`)
  })

  test('the toolbar comment lays the grid over the dashboard and starts a background session with the page context', async ({ page }) => {
    await openDashboard(page, agentSlug)

    await page.getByRole('button', { name: 'Add comment' }).click()
    const overlay = page.getByTestId('dashboard-comment-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.getByText('Whole dashboard · click to pin a spot')).toBeVisible()

    const message = nextSessionMessage(page, agentSlug)
    await overlay.getByPlaceholder('What should change?').fill('Use our brand colours')
    await overlay.getByRole('button', { name: 'Send' }).click()

    const sent = await message
    expect(sent).toMatch(/^Use our brand colours\n\n\[Dashboard comment context:\]\n/)
    expect(sent).toContain('"Q3 Revenue" dashboard')
    expect(sent).toContain('files in /workspace/artifacts/revenue/')
    expect(sent).toContain('- Page: `/`')
    expect(sent).toContain('Not pinned to a spot')
    expect(sent).toContain('[log] dashboard ready')
    expect(sent).toContain('[error] Chart failed: series is undefined')

    await expect(page.getByText(/^Sent to /)).toBeVisible()
    await expect(overlay).toBeHidden()
    // The session runs in the background: the dashboard stays on screen.
    await expect(page).toHaveURL(new RegExp(`/agents/${agentSlug}/dashboards/revenue$`))
  })

  test('a right-click in the dashboard offers "Comment here", which pins the comment to what was under it', async ({ page }) => {
    const frame = await openDashboard(page, agentSlug)

    await frame.getByTestId('emea-value').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Comment here…' }).click()

    const overlay = page.getByTestId('dashboard-comment-overlay')
    await expect(overlay.getByText('Pinned to this spot · drag or click to move')).toBeVisible()

    const message = nextSessionMessage(page, agentSlug)
    await overlay.getByPlaceholder('What should change?').fill('Make this green')
    await page.keyboard.press('Enter')

    const sent = await message
    expect(sent).toMatch(/^Make this green\n/)
    expect(sent).toMatch(/- Pinned at \(\d+, \d+\) px in the viewport/)
    expect(sent).toContain('- Under the pin: <span.value>, reading "$1.2M", inside text "EMEA $1.2M"')
  })

  test('Escape leaves comment mode without sending anything', async ({ page }) => {
    await openDashboard(page, agentSlug)
    let created = false
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/agents/${agentSlug}/sessions`) created = true
    })

    await page.getByRole('button', { name: 'Add comment' }).click()
    const overlay = page.getByTestId('dashboard-comment-overlay')
    await expect(overlay).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
    await expect(page.getByRole('button', { name: 'Add comment' })).toHaveAttribute('aria-pressed', 'false')
    expect(created).toBe(false)
  })
})
