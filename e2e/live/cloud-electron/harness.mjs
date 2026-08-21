/**
 * Drives the real desktop app against the live three-node stack, over CDP.
 *
 * Why CDP rather than Playwright's `_electron.launch()`: the thing under test is
 * how the app behaves across a *restart* and across *more than one window*. This
 * harness launches the Electron binary itself, so it owns the process lifetime
 * and the environment, and attaches with `chromium.connectOverCDP` — which sees
 * every BrowserWindow as a page, including the quick-dispatch launcher and the
 * dashboard popouts that the feature has to keep in step.
 *
 * The app must already be built (`npx electron-vite build`); this runs the
 * production entry, not the dev server, so nothing here depends on a Vite
 * process staying alive between restarts.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { chromium } from '@playwright/test'
import { STACK, CDP_PORT } from './stack.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MAIN_ENTRY = join(REPO_ROOT, 'dist/main/index.js')

/** Poll until `check()` is truthy, or throw. Every wait in the harness routes through here. */
export async function waitFor(label, check, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) {
      const detail = last instanceof Error ? `: ${last.message}` : ''
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${detail}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Write the app's `settings.json` before first boot.
 *
 * Seeds the connected platform account the way a user who has linked their
 * account would have it, plus `app.setupCompleted` — otherwise the first render
 * is the onboarding wizard, which covers the whole window and every control the
 * checks are looking for.
 */
export function seedDataDir(dataDir, overrides = {}) {
  mkdirSync(dataDir, { recursive: true })
  const now = new Date().toISOString()
  const token = STACK.platformToken
  const settings = {
    app: { setupCompleted: true, showMenuBarIcon: false },
    // NOT cosmetic, and not overridable. `shutdownActiveRunner()` reads this on
    // every quit and calls the runner's shutdown hook *without* consulting
    // `E2E_MOCK` — and `getLimaHome()` is `~/.superagent/lima`, shared with the
    // installed build rather than scoped to this data dir. Left at the macOS
    // default (`lima`), closing the harness force-stops the VM the user's own
    // Gamut is running on. `docker` has no shutdown hook, so quitting is a no-op.
    container: { containerRunner: 'docker' },
    platformAuth: {
      token,
      tokenPreview: `${token.slice(0, 6)}...${token.slice(-4)}`,
      email: STACK.email,
      label: 'live-e2e',
      orgId: STACK.orgId,
      orgName: STACK.orgName,
      role: 'owner',
      userId: null,
      memberId: null,
      createdAt: now,
      updatedAt: now,
    },
    ...overrides,
  }
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2))
  return settings
}

/** Read `settings.json` back — the harness asserts on persisted preferences. */
export function readSettings(dataDir) {
  const file = join(dataDir, 'settings.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function resetDataDir(dataDir) {
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
}

/**
 * Launch the app and attach over CDP.
 *
 * `SUPERAGENT_DISABLE_SINGLE_INSTANCE=1` is required, not optional: the lock
 * identity derives from `app.name`, which the installed build shares, so without
 * it this process exits silently the moment the user has Gamut open — and a
 * silent `app.exit(0)` reads exactly like a hang.
 */
export async function launchApp({ dataDir, cdpPort = CDP_PORT, env = {} } = {}) {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`missing ${MAIN_ENTRY} — run \`npx electron-vite build\` first`)
  }

  const logLines = []
  const proc = spawn(electronPath, [MAIN_ENTRY, `--remote-debugging-port=${cdpPort}`], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPERAGENT_DATA_DIR: dataDir,
      SUPERAGENT_DISABLE_SINGLE_INSTANCE: '1',
      PLATFORM_PROXY_URL: STACK.proxyUrl,
      PLATFORM_AUTH_ISSUER_URL: STACK.authIssuerUrl,
      // Mock container runtime: these checks are about which Superagent is being
      // driven, not about starting real containers on either side.
      E2E_MOCK: 'true',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let apiPort = null
  const capture = (chunk) => {
    const text = String(chunk)
    logLines.push(text)
    const match = text.match(/API server running on http:\/\/localhost:(\d+)/)
    if (match) apiPort = Number(match[1])
  }
  proc.stdout.on('data', capture)
  proc.stderr.on('data', capture)

  let exited = null
  proc.on('exit', (code, signal) => { exited = { code, signal } })

  const log = () => logLines.join('')

  await waitFor('the API server to bind', () => {
    if (exited) throw new Error(`electron exited (${exited.code}/${exited.signal})\n${log()}`)
    return apiPort
  }, { timeoutMs: 90_000 })

  const browser = await waitFor('the CDP endpoint', async () => {
    if (exited) throw new Error(`electron exited (${exited.code}/${exited.signal})\n${log()}`)
    return chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  }, { timeoutMs: 60_000 })

  const app = {
    proc,
    browser,
    apiPort,
    log,
    /** Every open window, as Playwright pages. */
    pages: () => browser.contexts().flatMap((context) => context.pages()),
    /** The main app window. */
    mainPage: () => waitForPage(browser, (url) => url.includes('/renderer/index.html')),
    /** The quick-dispatch launcher, which is its own renderer with its own target. */
    launcherPage: (opts) =>
      waitForPage(browser, (url) => url.includes('quick-dispatch.html'), opts),
    /** Windows whose document is served by a deployment rather than by this app. */
    remotePages: (opts) =>
      waitForPage(browser, (url) => url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:'), opts),
    close: async () => {
      await browser.close().catch(() => {})
      proc.kill('SIGKILL')
      await new Promise((resolve) => proc.once('exit', resolve))
    },
  }
  return app
}

/**
 * Find an open window by URL.
 *
 * Pages come and go across a target switch (the app reloads, the launcher is
 * destroyed and recreated), so this re-reads `contexts()` on every poll rather
 * than holding a snapshot.
 */
export async function waitForPage(browser, predicate, { timeoutMs = 30_000, optional = false } = {}) {
  try {
    return await waitFor('a window matching the predicate', () => {
      const pages = browser.contexts().flatMap((context) => context.pages())
      return pages.find((page) => {
        try {
          return predicate(page.url())
        } catch {
          return false
        }
      })
    }, { timeoutMs })
  } catch (error) {
    if (optional) return null
    throw error
  }
}

/** Wait until the renderer has settled the API target and mounted the app shell. */
export async function waitForAppReady(page, { timeoutMs = 60_000 } = {}) {
  await page.waitForSelector('[data-testid="app-sidebar"], [data-testid="wizard-container"]', {
    timeout: timeoutMs,
  })
}

/** The target this renderer settled on, read from the app's own module state. */
export async function readTarget(page) {
  return page.evaluate(async () => {
    const resolved = await window.electronAPI?.getApiTarget?.()
    return resolved ?? null
  })
}
