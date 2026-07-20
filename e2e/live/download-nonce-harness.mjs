#!/usr/bin/env node
/**
 * Live end-to-end validation of installer-carried identity.
 *
 * Drives the REAL stack, no mocks on the nonce path:
 *   1. Logs into the locally running platform web app with a seeded user and
 *      clicks the actual "Download for MacOS" button, capturing the stamped
 *      download URL (validates mint + button wiring).
 *   2. Creates a DMG named like a stamped installer and mounts it, so the
 *      app's hdiutil mount-scan channel recovers the code for real.
 *   3. Launches the built Electron app with a fresh data dir and
 *      --remote-debugging-port, connects over CDP, and asserts the
 *      onboarding button reads "Continue as <email>".
 *   4. Clicks it and verifies the redeemed plat_sa_ token lands in
 *      settings.json (and, when docker is available, that the nonce row is
 *      consumed in the local Supabase DB).
 *   5. Negative pass: relaunches with another fresh data dir while the same
 *      (now consumed) DMG is still mounted and asserts the button falls back
 *      to "Get Started" — flow unchanged.
 *
 * Prereqs:
 *   - Local Supabase running + seeded (bob@test.io / bobtest exists) with the
 *     download_nonce migration applied.
 *   - Platform web dev server on http://localhost:3000.
 *   - App built for electron:  npm run build:electron
 *     (with PLATFORM_BASE_URL/PLATFORM_PROXY_URL pointing at the local stack)
 *   - Native modules rebuilt for Electron:  npx electron-rebuild -f
 *
 * Run:  node e2e/live/download-nonce-harness.mjs
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { chromium } from '@playwright/test'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

const PLATFORM_URL = process.env.HARNESS_PLATFORM_URL || 'http://localhost:3000'
// When set (e.g. http://127.0.0.1:8790 from `wrangler dev` in gamut-releases),
// updates.gamutagents.com traffic is proxied to the local release worker and
// the browser REALLY downloads the stamped installer — validating the
// redirect + Content-Disposition leg too. Unset → the download nav is merely
// captured and a synthetic stamped DMG is used instead.
const WORKER_URL = process.env.HARNESS_WORKER_URL || null
const LOGIN_EMAIL = process.env.HARNESS_EMAIL || 'bob@test.io'
const LOGIN_PASSWORD = process.env.HARNESS_PASSWORD || 'bobtest'
const CDP_PORT = Number(process.env.HARNESS_CDP_PORT || 9333)
const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'download-nonce-live-'))
const cleanups = []
let failures = 0

function step(name) {
  process.stdout.write(`\n=== ${name}\n`)
}
function pass(msg) {
  process.stdout.write(`  PASS  ${msg}\n`)
}
function fail(msg) {
  failures += 1
  process.stdout.write(`  FAIL  ${msg}\n`)
}
async function expectEventually(fn, what, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for: ${what}${lastErr ? ` (${lastErr})` : ''}`)
}

// --- 1. Mint through the real dashboard ------------------------------------

async function mintNonceViaDownloadClick() {
  step('Mint: platform login + real download click')
  const browser = await chromium.launch({ headless: true })
  cleanups.push(() => browser.close().catch(() => {}))
  const context = await browser.newContext()
  const page = await context.newPage()

  let capturedUrl = null
  if (WORKER_URL) {
    // Proxy the branded host to the local worker; its 302 Location points at
    // 127.0.0.1 directly, so the browser follows and downloads for real.
    await context.route(/updates\.gamutagents\.com/, async (route) => {
      const u = new URL(route.request().url())
      capturedUrl = u.toString()
      const upstream = await fetch(`${WORKER_URL}${u.pathname}${u.search}`, {
        redirect: 'manual',
      })
      const headers = {}
      for (const [k, v] of upstream.headers) headers[k] = v
      return route.fulfill({
        status: upstream.status,
        headers,
        body: Buffer.from(await upstream.arrayBuffer()),
      })
    })
  } else {
    await context.route(/updates\.gamutagents\.com/, (route) => {
      capturedUrl = route.request().url()
      return route.abort()
    })
  }

  await page.goto(`${PLATFORM_URL}/auth/login`, { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('Email').fill(LOGIN_EMAIL)
  await page.getByPlaceholder('Password', { exact: true }).fill(LOGIN_PASSWORD)
  await page.locator('button[type="submit"]').first().click()
  // Generous: a cold Next dev server compiles routes on first hit.
  await page.waitForURL(/dashboard/, { timeout: 60_000 })
  pass(`logged in as ${LOGIN_EMAIL}`)

  // DownloadButtons render on the profile page for every user.
  await page.goto(`${PLATFORM_URL}/dashboard/profile`, { waitUntil: 'domcontentloaded' })
  const macLink = page.getByRole('link', { name: /download for macos/i })
  await macLink.waitFor({ timeout: 15_000 })

  const downloadPromise = WORKER_URL
    ? page.waitForEvent('download', { timeout: 30_000 })
    : null
  await macLink.click()

  await expectEventually(() => capturedUrl, 'stamped download navigation', 15_000)
  const code = new URL(capturedUrl).searchParams.get('dl')
  if (!code || !/^[a-f0-9]{40,64}$/.test(code)) {
    throw new Error(`download URL not stamped with a valid code: ${capturedUrl}`)
  }
  pass(`download URL stamped: ...?dl=${code.slice(0, 8)}… (${code.length} hex chars)`)

  let downloadedDmg = null
  if (downloadPromise) {
    const download = await downloadPromise
    const suggested = download.suggestedFilename()
    if (new RegExp(`-${code}\\.dmg$`).test(suggested)) {
      pass(`worker stamped the saved filename: ${suggested}`)
    } else {
      fail(`saved filename not stamped: ${suggested}`)
    }
    downloadedDmg = path.join(workRoot, suggested)
    await download.saveAs(downloadedDmg)
    pass('installer really downloaded through the local release worker')
  }

  await browser.close()
  return { code, downloadedDmg }
}

// --- 2. Stamped DMG, really mounted -----------------------------------------

async function mountStampedDmg(code, downloadedDmg) {
  step(downloadedDmg ? 'Mount: attach the actually-downloaded DMG' : 'Mount: create + attach stamped DMG')
  let dmgPath = downloadedDmg
  if (!dmgPath) {
    const srcDir = path.join(workRoot, 'dmg-src')
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(path.join(srcDir, 'README.txt'), 'harness payload\n')
    dmgPath = path.join(workRoot, `Gamut-0.0.0-${code}.dmg`)
    await execFileAsync('hdiutil', [
      'create', '-volname', 'Gamut', '-srcfolder', srcDir, '-format', 'UDZO', '-ov', dmgPath,
    ])
  }
  const { stdout } = await execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath])
  const mountPoint = stdout.split('\n').flatMap((l) => l.split('\t')).find((f) => f.trim().startsWith('/Volumes/'))
  if (!mountPoint) throw new Error(`could not find mount point in: ${stdout}`)
  cleanups.push(() =>
    execFileAsync('hdiutil', ['detach', mountPoint.trim(), '-force']).catch(() => {}),
  )
  pass(`mounted ${path.basename(dmgPath)} at ${mountPoint.trim()}`)
  return dmgPath
}

// --- 3./5. Launch the app and inspect the onboarding button over CDP --------

async function launchApp({ dataDir, cdpPort }) {
  await fs.mkdir(dataDir, { recursive: true })
  const electronBin = require('electron')
  const mainEntry = path.join(APP_ROOT, 'dist', 'main', 'index.js')
  await fs.access(mainEntry).catch(() => {
    throw new Error('dist/main/index.js missing — run `npm run build:electron` first')
  })
  const child = spawn(electronBin, [mainEntry, `--remote-debugging-port=${cdpPort}`], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      SUPERAGENT_DATA_DIR: dataDir,
      PLATFORM_BASE_URL: PLATFORM_URL,
      E2E_MOCK: 'true',
      // The single-instance lock is shared with the installed app; opt out so
      // the harness can run while the user's Gamut is open (dev-only gate).
      SUPERAGENT_DISABLE_SINGLE_INSTANCE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(d.toString()))
  child.stderr.on('data', (d) => logs.push(d.toString()))
  cleanups.push(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already exited.
    }
  })

  const cdp = await expectEventually(
    () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`).catch(() => null),
    `CDP endpoint on :${cdpPort}`,
    60_000,
    500,
  )
  const page = await expectEventually(
    async () => {
      for (const context of cdp.contexts()) {
        for (const p of context.pages()) {
          if (await p.locator('[data-testid="wizard-platform-login"]').count()) return p
        }
      }
      return null
    },
    'app window with onboarding wizard',
    60_000,
    500,
  )
  return { child, cdp, page, logs }
}

async function assertContinueAs(page) {
  step('Assert: onboarding button offers "Continue as <email>" (via CDP)')
  const button = page.locator('[data-testid="wizard-platform-login"]')
  await expectEventually(
    async () => ((await button.textContent()) || '').includes(`Continue as ${LOGIN_EMAIL}`),
    `button text "Continue as ${LOGIN_EMAIL}"`,
    30_000,
  )
  pass(`button reads "Continue as ${LOGIN_EMAIL}"`)
  const notYou = page.locator('[data-testid="wizard-nonce-dismiss"]')
  if ((await notYou.count()) > 0) pass('"Not you?" escape hatch rendered')
  else fail('"Not you?" escape hatch missing')
  return button
}

async function redeemAndVerify(page, button, dataDir, code) {
  step('Redeem: click through and verify persisted connection')
  await button.click()
  const settings = await expectEventually(
    async () => {
      const raw = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(() => null)
      if (!raw) return null
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return null // mid-write; poll again
      }
      return parsed.platformAuth?.token ? parsed : null
    },
    'platformAuth record in settings.json',
    30_000,
  )
  const auth = settings.platformAuth
  if (auth.token.startsWith('plat_sa_')) pass(`plat_sa_ token persisted (${auth.tokenPreview ?? 'preview n/a'})`)
  else fail(`unexpected token shape: ${auth.token.slice(0, 12)}…`)
  if (auth.email === LOGIN_EMAIL) pass(`connected as ${auth.email}`)
  else fail(`connected email mismatch: ${auth.email}`)
  if (auth.memberId?.startsWith('sub_')) pass(`member-scoped: ${auth.memberId}`)
  else fail(`memberId missing/odd: ${auth.memberId}`)

  await expectEventually(
    async () => (await page.locator('[data-testid="wizard-platform-login"]').count()) === 0
      || !((await page.locator('[data-testid="wizard-platform-login"]').textContent().catch(() => '')) || '').includes('Continue as'),
    'wizard advanced past the welcome step',
    20_000,
  ).then(
    () => pass('wizard advanced past welcome step'),
    () => fail('wizard did not advance'),
  )

  // DB-side verification (best effort: needs local docker supabase).
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec', 'supabase_db_platform', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc',
      `select consumed_at is not null from public.download_nonce where code = '${code}';`,
    ])
    if (stdout.trim() === 't') pass('nonce row consumed in DB')
    else fail(`nonce row not consumed (got: ${stdout.trim() || 'no row'})`)
  } catch {
    process.stdout.write('  SKIP  DB check (docker/supabase not reachable)\n')
  }
}

async function assertFallbackFlow() {
  step('Negative: consumed nonce → flow unchanged ("Get Started")')
  const dataDir2 = path.join(workRoot, 'app-data-negative')
  const { cdp, page } = await launchApp({ dataDir: dataDir2, cdpPort: CDP_PORT + 1 })
  const button = page.locator('[data-testid="wizard-platform-login"]')
  // Give the offer query time to resolve (it 404s against the consumed nonce),
  // then require the plain label. The label must never be "Continue as".
  await new Promise((r) => setTimeout(r, 4000))
  const text = (await button.textContent()) || ''
  if (text.includes('Get Started') && !text.includes('Continue as')) {
    pass(`fallback intact: button reads "${text.trim()}"`)
  } else {
    fail(`unexpected button text on consumed nonce: "${text.trim()}"`)
  }
  await cdp.close().catch(() => {})
}

// --- Run ---------------------------------------------------------------------

try {
  const { code, downloadedDmg } = await mintNonceViaDownloadClick()
  await mountStampedDmg(code, downloadedDmg)

  const dataDir = path.join(workRoot, 'app-data')
  const { cdp, page } = await launchApp({ dataDir, cdpPort: CDP_PORT })
  const button = await assertContinueAs(page)
  await redeemAndVerify(page, button, dataDir, code)
  await cdp.close().catch(() => {})

  await assertFallbackFlow()
} catch (err) {
  fail(`harness aborted: ${err?.stack || err}`)
} finally {
  for (const fn of cleanups.reverse()) await fn()
}

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
