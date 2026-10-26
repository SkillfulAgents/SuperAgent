/**
 * Runs real app interaction contracts in the built Electron file:// renderer.
 * The CI desktop job builds this checkout first; this harness never builds.
 *
 * E2E_MOCK=true xvfb-run --auto-servernum npx tsx e2e/live/radix/run.ts
 *
 * The app, preload bridge, APIs, persistence and Radix controls are real.
 * Model output and remote provider listings use the shared E2E fixtures.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { WebContents, WebPreferences } from 'electron'
import { runRadixInteractionChecks } from '../../helpers/radix-interactions'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const artifacts = resolve(repoRoot, 'test-results/electron-radix')

async function closeApp(app: ElectronApplication) {
  const electronProcess = app.process()
  const kill = setTimeout(() => electronProcess.kill('SIGKILL'), 10_000)
  try {
    await app.close()
  } finally {
    clearTimeout(kill)
    if (electronProcess.exitCode === null && electronProcess.signalCode === null) {
      await new Promise<void>(done => {
        electronProcess.once('exit', () => done())
        electronProcess.kill('SIGKILL')
      })
    }
  }
}

async function main() {
  const entry = join(repoRoot, 'dist/main/index.js')
  const renderer = join(repoRoot, 'dist/renderer/index.html')
  if (!existsSync(entry) || !existsSync(renderer)) {
    throw new Error('Missing desktop build. Run this harness after the CI desktop build; it does not build locally.')
  }
  mkdirSync(artifacts, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'electron-radix-'))
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
  const logs: string[] = []
  const pageErrors: string[] = []
  const interactionWarnings: string[] = []
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let traceStarted = false
  try {
    // This seeds synthetic data, opts out of analytics and selects the Docker
    // mock. Quitting this app cannot stop the user's shared Lima runtime.
    execFileSync(process.execPath, [join(repoRoot, 'e2e/setup-e2e-data.js')], {
      cwd: repoRoot, env, stdio: 'pipe',
    })
    app = await _electron.launch({ args: [entry], cwd: repoRoot, env, timeout: 60_000 })
    app.process().stdout?.on('data', chunk => logs.push(String(chunk)))
    app.process().stderr?.on('data', chunk => logs.push(String(chunk)))
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    traceStarted = true
    await expect.poll(
      () => app!.windows().find(window => window.url().includes('/renderer/index.html'))?.url(),
      { timeout: 60_000 },
    ).toBeTruthy()
    page = app.windows().find(window => window.url().includes('/renderer/index.html'))!
    page.setDefaultTimeout(30_000)
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('crash', () => pageErrors.push('Electron renderer crashed'))
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') logs.push(message.text())
      if (/requires a .*Title|Missing.*Description|Maximum update depth exceeded|FocusScope/i.test(message.text())) {
        interactionWarnings.push(message.text())
      }
    })
    expect(page.url()).toMatch(/^file:\/\//)
    expect(fileURLToPath(page.url().split('#')[0])).toBe(renderer)
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/index.html'))
      if (!window) throw new Error('Main Electron window was not found')
      window.setSize(1280, 900)
      window.show()
      window.focus()
      // Electron 43 uses this internal API itself, but omits it from its public
      // declarations. Keep the narrow assertion local to this test harness.
      const contents = window.webContents as WebContents & {
        getLastWebPreferences(): WebPreferences | null
      }
      const preferences = contents.getLastWebPreferences()
      if (!preferences) throw new Error('Electron did not expose the renderer web preferences')
      return {
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        sandbox: preferences.sandbox,
      }
    })
    expect(preferences).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    await expect(page.getByTestId('new-agent-button')).toBeVisible({ timeout: 60_000 })
    const apiBaseUrl = await page.evaluate(() => window.electronAPI!.getApiUrl())
    expect(new URL(apiBaseUrl).hostname).toBe('localhost')
    const settings = await app.context().request.put(`${apiBaseUrl}/api/settings`, {
      data: { apiKeys: { anthropicApiKey: 'sk-ant-e2e-mock-key' } },
    })
    expect(settings.ok()).toBe(true)
    console.log('PASS real Electron window loaded the built file:// renderer and connected through its preload API bridge')

    const rendererUrl = pathToFileURL(renderer).href
    await runRadixInteractionChecks({
      page,
      request: app.context().request,
      apiBaseUrl,
      navigate: async path => { await page!.goto(`${rendererUrl}#${path}`) },
    })
    expect(pageErrors).toEqual([])
    expect(interactionWarnings).toEqual([])
    await page.screenshot({ path: join(artifacts, 'completed.png'), fullPage: true })
    console.log('PASS built Electron interaction contracts completed without renderer errors or Radix accessibility/focus warnings')
  } catch (error) {
    console.error(logs.join('\n').slice(-12_000))
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifacts, 'failed.png'), fullPage: true }).catch(screenshotError => {
        console.error('Could not capture Electron failure screenshot:', screenshotError)
      })
    }
    throw error
  } finally {
    try {
      if (app) {
        if (traceStarted) {
          await app.context().tracing.stop({ path: join(artifacts, 'trace.zip') }).catch(traceError => {
            console.error('Could not save Electron interaction trace:', traceError)
          })
        }
        await closeApp(app)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
