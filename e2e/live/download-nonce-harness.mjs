#!/usr/bin/env node
/**
 * Live end-to-end validation of installer-carried identity.
 *
 * Drives the REAL stack, no mocks on the nonce path:
 *   1. Logs into the locally running platform web app with a seeded user,
 *      opens the workspace Get Started tab, and clicks the actual
 *      "Download for MacOS" button — exercising the memberId threading and
 *      startStampedDownload() mint for real. The stamped navigation is
 *      captured at the network layer and the code extracted from its ?dl=.
 *      Alongside, API negatives: unscoped mint → 400, foreign-membership
 *      mint → 403.
 *   2. Creates a DMG named like a stamped installer (or, in worker mode,
 *      uses the actually-downloaded one) and mounts it, so the app's hdiutil
 *      mount-scan channel recovers the code for real.
 *   3. Launches the built Electron app with a fresh data dir and
 *      --remote-debugging-port, connects over CDP, and asserts the
 *      onboarding button reads "Continue as <email>".
 *   4. Clicks it and verifies the redeemed plat_sa_ token lands in
 *      settings.json (and, when docker is available, that the nonce row is
 *      consumed in the local Supabase DB). Then replays the redeem with the
 *      consumed code and requires the uniform 404.
 *   5. Negative pass: relaunches with another fresh data dir while the same
 *      (now consumed) DMG is still mounted. The app's own offer endpoint is
 *      polled until the offer SETTLES (the GET awaits the full scan +
 *      resolve chain), then the button must read "Get Started" — flow
 *      unchanged.
 *
 * Prereqs:
 *   - Local Supabase running + seeded (bob@test.io / bobtest exists) with the
 *     download_nonce migration applied.
 *   - Platform web dev server on http://localhost:3000.
 *   - App built for electron:  npm run build:electron
 *     (with PLATFORM_BASE_URL/PLATFORM_PROXY_URL pointing at the local stack)
 *   - Native modules rebuilt for Electron:  npx electron-rebuild -f
 *
 * Note: the platform's nonce endpoints share a 30/min/IP rate limiter across
 * mint/resolve/redeem — rapid back-to-back runs can surface as 429s; wait a
 * minute or restart the platform dev server.
 *
 * Run:  node e2e/live/download-nonce-harness.mjs
 */

import crypto from 'node:crypto'
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
// Seeded membership of the login user — the real download button must mint
// for exactly this membership. Override when the seed's workspace differs.
const MEMBER_ID = process.env.HARNESS_MEMBER_ID || 'sub_ba2caa9e-476a-4a60-9cc2-6138e6b2b7a8'
const CDP_PORT = Number(process.env.HARNESS_CDP_PORT || 9333)
const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'download-nonce-live-'))
const cleanups = []
// { name, logs } per launched app — dumped when any check fails, since the
// app's own output is usually the only diagnostic for CDP/wizard timeouts.
const appLogTails = []
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

async function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop()
    try {
      await fn()
    } catch {
      // Best-effort teardown.
    }
  }
}

// Ctrl-C must not leave Electron instances and mounted DMGs behind — a stale
// app on the CDP port poisons the next run's connectOverCDP.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    process.stdout.write(`\n${sig} received — cleaning up\n`)
    runCleanups().finally(() => process.exit(130))
  })
}

function dumpAppLogTails() {
  for (const { name, logs } of appLogTails) {
    const tail = logs.join('').split('\n').slice(-40).join('\n').trim()
    process.stdout.write(`\n--- app log tail (${name}) ---\n${tail || '(no output)'}\n`)
  }
}

// --- 1. Mint through the real dashboard download button ---------------------

async function mintViaRealDownloadClick() {
  step('Mint: platform login + real "Download for MacOS" click')
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
  // Generous: a cold Next dev server compiles routes on first hit. /dashboard
  // redirects to the user's workspace page, which carries the org id.
  await page.waitForURL(/\/dashboard\/organizations\/[^/?]+/, { timeout: 60_000 })
  const orgId = new URL(page.url()).pathname.split('/')[3]
  pass(`logged in as ${LOGIN_EMAIL} (workspace ${orgId})`)

  // API negatives through the page's session cookies: workspace scoping is
  // mandatory (no guessing), and other users' memberships are off-limits.
  const unscoped = await page.request.post(`${PLATFORM_URL}/api/download-nonce/mint`, {
    data: {},
  })
  if (unscoped.status() === 400) pass('unscoped mint refused (400) — no workspace guessing')
  else fail(`unscoped mint not refused: ${unscoped.status()}`)

  const foreign = await page.request.post(`${PLATFORM_URL}/api/download-nonce/mint`, {
    data: { member_id: 'sub_00000000-0000-0000-0000-000000000000' },
  })
  if (foreign.status() === 403) pass('foreign-membership mint refused (403)')
  else fail(`foreign-membership mint not refused: ${foreign.status()}`)

  // The real button lives on the Get Started tab, behind the phone
  // verification card for fresh users — skip that gate if it's up.
  await page.goto(`${PLATFORM_URL}/dashboard/organizations/${orgId}?tab=getting-started`, {
    waitUntil: 'domcontentloaded',
  })
  const macButton = page.getByRole('link', { name: 'Download for MacOS' })
  const skipLink = page.getByText('Skip for now')
  await expectEventually(
    async () =>
      (await macButton.isVisible().catch(() => false)) ||
      (await skipLink.isVisible().catch(() => false)),
    'Get Started tab content',
    30_000,
  )
  if (!(await macButton.isVisible().catch(() => false))) {
    await skipLink.click()
    pass('skipped the phone-verification gate')
  }
  await macButton.waitFor({ state: 'visible', timeout: 30_000 })

  const downloadPromise = WORKER_URL ? page.waitForEvent('download', { timeout: 30_000 }) : null
  await macButton.click()
  await expectEventually(() => capturedUrl, 'stamped download navigation captured', 30_000)

  const captured = new URL(capturedUrl)
  const code = captured.searchParams.get('dl') || ''
  // Exactly 48 hex — anything shorter would be an entropy downgrade even if
  // the redeem path (40-64) still accepted it.
  if (!/^[a-f0-9]{48}$/.test(code)) {
    throw new Error(`captured download URL not stamped as expected: ${capturedUrl}`)
  }
  if (!captured.pathname.endsWith('/download/mac')) {
    fail(`unexpected download path: ${captured.pathname}`)
  }
  pass(`real button minted + navigated stamped URL: dl=${code.slice(0, 8)}… (48 hex chars)`)

  let downloadedDmg = null
  if (WORKER_URL) {
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

async function launchApp({ dataDir, cdpPort, name }) {
  // A leftover instance from an aborted prior run would make connectOverCDP
  // attach to stale state — refuse to run instead.
  const stale = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`).catch(() => null)
  if (stale) {
    await stale.close().catch(() => {})
    throw new Error(`something already answers CDP on :${cdpPort} — stale harness run? Kill it first.`)
  }

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
  appLogTails.push({ name, logs })
  child.stdout.on('data', (d) => logs.push(d.toString()))
  child.stderr.on('data', (d) => logs.push(d.toString()))
  cleanups.push(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already exited.
    }
  })

  // The bound port is dynamic (bindServerWithRetry walks past busy ports);
  // the startup log line is the source of truth.
  const apiPort = await expectEventually(
    () => {
      const m = logs.join('').match(/API server running on http:\/\/localhost:(\d+)/)
      return m ? Number(m[1]) : null
    },
    'app API port in startup logs',
    60_000,
    250,
  )

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
  return { child, cdp, page, apiPort }
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
  // The button minted this itself — proves the memberId threading end to end.
  if (auth.memberId === MEMBER_ID) pass(`scoped to the expected membership: ${auth.memberId}`)
  else fail(`memberId mismatch: got ${auth.memberId}, expected ${MEMBER_ID} (override HARNESS_MEMBER_ID if the seed changed)`)

  await expectEventually(
    async () => (await page.locator('[data-testid="wizard-platform-login"]').count()) === 0
      || !((await page.locator('[data-testid="wizard-platform-login"]').textContent().catch(() => '')) || '').includes('Continue as'),
    'wizard advanced past the welcome step',
    20_000,
  ).then(
    () => pass('wizard advanced past welcome step'),
    () => fail('wizard did not advance'),
  )

  // Replay: the code is consumed now; the platform must return the uniform
  // 404 (no oracle distinguishing consumed from never-existed).
  const replay = await fetch(`${PLATFORM_URL}/api/download-nonce/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (replay.status === 404) pass('redeem replay of consumed code → uniform 404')
  else fail(`redeem replay not refused: ${replay.status}`)

  // DB-side verification (best effort: needs local docker supabase). Only the
  // code's hash is at rest — plaintext never touches the platform DB.
  const codeHash = crypto.createHash('sha256').update(code).digest('hex')
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec', 'supabase_db_platform', 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc',
      `select (consumed_at is not null) || '|' || coalesce(created_ua, '-') || '|' || coalesce(consumed_ua, '-') from public.download_nonce where code_hash = '${codeHash}';`,
    ])
    const [consumed, createdUa, consumedUa] = stdout.trim().split('|')
    // `boolean || text` renders as 'true'/'false', not psql's bare 't'/'f'.
    if (consumed === 'true') pass('nonce row consumed in DB (by hash — plaintext not at rest)')
    else fail(`nonce row not consumed (got: ${stdout.trim() || 'no row'})`)
    // Proxy-derived context is best-effort in local dev (no trusted proxy).
    process.stdout.write(`  INFO  audit context — mint ua: ${createdUa.slice(0, 40)} · redeem ua: ${consumedUa.slice(0, 40)}\n`)
  } catch {
    process.stdout.write('  SKIP  DB check (docker/supabase not reachable)\n')
  }
}

async function assertFallbackFlow() {
  step('Negative: consumed nonce → flow unchanged ("Get Started")')
  const dataDir2 = path.join(workRoot, 'app-data-negative')
  const { cdp, page, apiPort } = await launchApp({
    dataDir: dataDir2,
    cdpPort: CDP_PORT + 1,
    name: 'negative pass',
  })

  // Deterministic settling instead of a sleep: the offer GET awaits the full
  // scan + resolve chain before responding, so a response proves resolution
  // ran against the consumed nonce. Read twice — the transient-failure branch
  // also reports unavailable but leaves the offer unresolved, and a second
  // read re-runs it.
  const offerUrl = `http://127.0.0.1:${apiPort}/api/platform-auth/download-nonce`
  const readOffer = async () => {
    const res = await fetch(offerUrl)
    if (!res.ok) throw new Error(`offer endpoint returned ${res.status}`)
    return res.json()
  }
  const first = await expectEventually(readOffer, 'offer endpoint to respond', 30_000)
  const second = await readOffer()
  if (first.available === false && second.available === false) {
    pass('offer settled as unavailable (consumed nonce rejected by resolve)')
  } else {
    fail(`offer unexpectedly available: ${JSON.stringify(second)}`)
  }

  const text = (await page.locator('[data-testid="wizard-platform-login"]').textContent()) || ''
  if (text.includes('Get Started') && !text.includes('Continue as')) {
    pass(`fallback intact: button reads "${text.trim()}"`)
  } else {
    fail(`unexpected button text on consumed nonce: "${text.trim()}"`)
  }
  await cdp.close().catch(() => {})
}

// --- Run ---------------------------------------------------------------------

try {
  const { code, downloadedDmg } = await mintViaRealDownloadClick()
  await mountStampedDmg(code, downloadedDmg)

  const dataDir = path.join(workRoot, 'app-data')
  const appA = await launchApp({ dataDir, cdpPort: CDP_PORT, name: 'positive pass' })
  const button = await assertContinueAs(appA.page)
  await redeemAndVerify(appA.page, button, dataDir, code)
  await appA.cdp.close().catch(() => {})
  // Kill the first instance before the negative pass runs — one app at a
  // time keeps ports and mounted-volume access unambiguous.
  try {
    appA.child.kill('SIGKILL')
  } catch {
    // Already exited.
  }

  await assertFallbackFlow()
} catch (err) {
  fail(`harness aborted: ${err?.stack || err}`)
} finally {
  await runCleanups()
}

if (failures > 0) {
  dumpAppLogTails()
  process.stdout.write(`\n  INFO  work dir kept for debugging: ${workRoot}\n`)
} else {
  await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {})
}

// Write the verdict through the callback so a piped stdout (tee) can't lose
// the final line to process.exit.
process.stdout.write(
  `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`,
  () => process.exit(failures === 0 ? 0 : 1),
)
