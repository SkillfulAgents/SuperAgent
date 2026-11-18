/**
 * PDF smoke against the built Electron app, including its file:// worker URL.
 * CI already builds the desktop app before running this; this script never builds.
 *
 *   xvfb-run --auto-servernum npx tsx e2e/live/pdf-preview/run.ts
 *
 * PDF_E2E_APP_ROOT may point at an existing build for local investigation. Such
 * a run validates that build, not the current checkout. Model work is mocked;
 * the app, upload API, PDF.js worker and rendered PDF are real.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { SessionPage } from '../../pages/session.page'
import { pdfFixture } from '../../helpers/pdf-fixture'
import { timestampedUploadNamePattern } from '../../helpers/upload-filename'
import { CreatedAgentSchema } from './schemas'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const appRoot = resolve(process.env.PDF_E2E_APP_ROOT || repoRoot)
const title = 'Quarterly revenue review'

async function expectPage(page: Page, number: number) {
  await expect(page.getByText(number === 1 ? title : 'Forecast and next steps', { exact: true })).toBeVisible()
  await expect(page.getByTestId('pdf-pagination')).toContainText(`${number} / 2`)
  await expect.poll(async () => page.locator('[data-page-number] canvas').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let ink = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] && pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100) ink++
    }
    return ink
  })).toBeGreaterThan(100)
}

async function main() {
  const entry = join(appRoot, 'dist/main/index.js')
  if (!existsSync(entry)) throw new Error(`Missing desktop build: ${entry}. Run this harness in the CI build job.`)
  console.log(`PDF smoke build: ${appRoot}${appRoot !== repoRoot ? ' (external build; not current-head validation)' : ''}`)
  const scratch = mkdtempSync(join(tmpdir(), 'electron-pdf-'))
  const env = {
    ...process.env,
    SUPERAGENT_DATA_DIR: join(scratch, 'data'),
    SUPERAGENT_DISABLE_SINGLE_INSTANCE: '1',
    XDG_CONFIG_HOME: join(scratch, 'config'),
    XDG_CACHE_HOME: join(scratch, 'cache'),
    E2E_MOCK: 'true',
    AUTH_MODE: 'false',
    PLATFORM_BASE_URL: '', PLATFORM_PROXY_URL: '', PLATFORM_AUTH_ISSUER_URL: '', PLATFORM_TOKEN: '',
    ELECTRON_RENDERER_URL: '',
  }
  let app: ElectronApplication | undefined
  const logs: string[] = []
  try {
    // Existing setup uses the Docker mock and opts out of analytics. In
    // particular, quitting cannot stop the user's own Lima VM.
    execFileSync(process.execPath, [join(repoRoot, 'e2e/setup-e2e-data.js')], { cwd: repoRoot, env, stdio: 'pipe' })
    app = await _electron.launch({
      args: [entry, ...(process.env.PDF_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
      cwd: appRoot,
      env,
      timeout: 60_000,
    })
    app.process().stdout?.on('data', chunk => logs.push(String(chunk)))
    app.process().stderr?.on('data', chunk => logs.push(String(chunk)))
    await expect.poll(() => app!.windows().find(window => window.url().includes('/renderer/index.html'))?.url(), { timeout: 60_000 }).toBeTruthy()
    const page = app.windows().find(window => window.url().includes('/renderer/index.html'))!
    page.setDefaultTimeout(30_000)
    expect(page.url()).toMatch(/^file:\/\//)
    expect(fileURLToPath(new URL(page.url()).href.split('#')[0])).toBe(join(appRoot, 'dist/renderer/index.html'))
    await expect(page.getByTestId('new-agent-button')).toBeVisible({ timeout: 60_000 })
    const apiUrl = await page.evaluate(() => window.electronAPI!.getApiUrl())
    expect(new URL(apiUrl).hostname).toBe('localhost')

    const externalRequests: string[] = []
    const warnings: string[] = []
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (/fake worker|worker version|API version/i.test(message.text())) warnings.push(message.text())
    })
    await app.context().route('**/*', route => {
      const url = new URL(route.request().url())
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(apiUrl).origin) {
        externalRequests.push(url.href)
        return route.abort()
      }
      return route.continue()
    })
    const settings = await fetch(`${apiUrl}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKeys: { anthropicApiKey: 'sk-ant-e2e-mock-key' } }),
    })
    expect(settings.ok).toBe(true)
    const created = await fetch(`${apiUrl}/api/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Packaged PDF validation' }),
    })
    expect(created.status).toBe(201)
    const { slug } = CreatedAgentSchema.parse(await created.json())
    // A named agent avoids the unrelated AI naming flow. Model execution is
    // mocked; this test needs the real upload/file-preview path, not naming.
    await page.goto(`${pathToFileURL(join(appRoot, 'dist/renderer/index.html')).href}#/agents/${encodeURIComponent(slug)}`)
    await expect(page.getByTestId('agent-settings-button')).toBeVisible()
    const session = new SessionPage(page)
    await session.sendMessage('hello')
    await session.waitForResponse(30_000)
    await session.waitForInputEnabled()
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({
      name: 'report.pdf', mimeType: 'application/pdf', buffer: pdfFixture(),
    })
    await expect(page.getByTestId('attachment-preview').filter({ hasText: 'report.pdf' })).toBeVisible()
    await session.sendMessage('Inspect this PDF')
    const pill = page.getByTestId('file-pill').filter({ hasText: timestampedUploadNamePattern('report.pdf') }).first()
    await expect(pill).toBeVisible()
    await session.waitForInputEnabled()

    const workerCreated = page.waitForEvent('worker')
    await pill.click()
    const worker = await workerCreated
    await expectPage(page, 1)
    expect(await worker.evaluate(() => typeof document)).toBe('undefined')
    // PDF.js wraps file:// modules in a blob worker because file origins are
    // opaque. Inspect the real wrapper so a CDN/fake worker cannot pass.
    const workerSource = worker.url().startsWith('blob:')
      ? await page.evaluate(async url => (await fetch(url)).text(), worker.url())
      : worker.url()
    expect(workerSource).toContain(`${pathToFileURL(join(appRoot, 'dist/renderer/assets/')).href}pdf.worker`)
    expect(warnings).toEqual([])
    expect(externalRequests.filter(url => /pdf|worker|font|cmaps/i.test(url))).toEqual([])
    console.log('PASS built file:// renderer uses its local real PDF.js worker; canvas and text render without CDN requests')

    const text = page.getByText(title, { exact: true })
    // Opening the pane animates its width; PDF.js replaces text nodes on each
    // resize. Retry the gesture if that replacement races the initial bounds.
    await expect(async () => {
      await text.scrollIntoViewIfNeeded()
      const bounds = await text.boundingBox()
      expect(bounds).not.toBeNull()
      await page.mouse.move(bounds!.x + 1, bounds!.y + bounds!.height / 2)
      await page.mouse.down()
      try {
        await page.mouse.move(bounds!.x + bounds!.width - 1, bounds!.y + bounds!.height / 2, { steps: 15 })
      } finally { await page.mouse.up() }
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(title)
    }).toPass({ timeout: 10_000, intervals: [100, 250] })
    console.log('PASS real pointer selection matches the painted PDF text')

    await page.getByRole('button', { name: 'Next PDF page' }).click()
    await expectPage(page, 2)
    await expect(page.getByRole('button', { name: 'Next PDF page' })).toBeDisabled()
    await page.getByRole('button', { name: 'Hide files panel' }).click()
    await expect(page.locator('[data-page-number]')).not.toBeVisible()
    await pill.click()
    await expectPage(page, 2)
    await page.getByRole('button', { name: 'Previous PDF page' }).click()
    await expectPage(page, 1)
    expect(warnings).toEqual([])
    expect(pageErrors).toEqual([])
    console.log('PASS page navigation and pane reopen preserve the page and render again')
  } catch (error) {
    console.error(logs.join('').slice(-8_000))
    throw error
  } finally {
    try {
      if (app) {
        const electronProcess = app.process()
        const kill = setTimeout(() => electronProcess.kill('SIGKILL'), 10_000)
        try { await app.close() } finally {
          clearTimeout(kill)
          if (electronProcess.exitCode === null && electronProcess.signalCode === null) {
            await new Promise<void>(done => {
              electronProcess.once('exit', () => done())
              electronProcess.kill('SIGKILL')
            })
          }
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
