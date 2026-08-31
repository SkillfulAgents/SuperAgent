/**
 * Live validation of the cloud-workspace feature: the real desktop app, driven
 * over CDP, against the real three-node stack.
 *
 * Run the stack first — see
 * `.claude/skills/electron-cloud-interface-validation/SKILL.md` — then:
 *
 *   npx electron-vite build
 *   node e2e/live/cloud-electron/run.mjs
 *
 * Unit tests for this feature mock the network wholesale and can see none of
 * what is checked here: that cloud mode reaches a *different machine's* data,
 * that every renderer request goes through the loopback proxy instead of to the
 * deployment, that better-auth resolves a session against the proxy prefix, that
 * the preference survives a restart, and that the windows caching a base URL for
 * their lifetime are torn down when it changes.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  launchApp,
  seedDataDir,
  resetDataDir,
  readSettings,
  waitForAppReady,
  waitFor,
} from './harness.mjs'
import { STACK, CDP_PORT } from './stack.mjs'

const DATA_DIR = process.env.LIVE_APP_DATA_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'cloud-live-app')
const NODE3_DATA = process.env.LIVE_NODE3_DATA_DIR ?? ''

const results = []
let currentGroup = ''

function group(title) {
  currentGroup = title
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

/**
 * Every failure prints what was on screen when it happened.
 *
 * Without this a timed-out selector says only that something was missing, and in
 * a suite where one stuck screen cascades into a dozen red checks, the first
 * message is the only one that carries information.
 */
async function describePage() {
  try {
    return await page.evaluate(() => ({
      url: location.hash || location.pathname,
      testids: [...document.querySelectorAll('[data-testid]')]
        .map((el) => el.getAttribute('data-testid'))
        .slice(0, 25),
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220),
    }))
  } catch (error) {
    return { unavailable: String(error.message).slice(0, 120) }
  }
}

async function check(name, fn) {
  try {
    await fn()
    results.push({ group: currentGroup, name, ok: true })
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (error) {
    results.push({ group: currentGroup, name, ok: false, error })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${String(error.message).split('\n').slice(0, 3).join('\n      ')}`)
    const shown = await describePage()
    console.log(`      on screen: ${JSON.stringify(shown)}`)
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, wanted, message) {
  if (actual !== wanted) throw new Error(`${message}\n  expected: ${wanted}\n  actual:   ${actual}`)
}

// ─── driving the app ────────────────────────────────────────────────────────

/**
 * The target the *renderer* settled on, as the UI itself reports it.
 *
 * Deliberately not `electronAPI.getApiTarget()`: that is the main process's
 * answer, which changes the instant the preference is written. Only the DOM says
 * what this renderer actually booted with.
 */
async function rendererTarget(page) {
  // `<html data-api-target>`, stamped by `setActiveTarget()` alongside the value
  // it mirrors. Read it rather than any on-screen chrome: a switch into a
  // not-yet-onboarded workspace lands on the wizard, which replaces the whole
  // shell — sidebar, switcher and all — so "no switcher" would read identically
  // to "switch never happened", which is a 90s timeout rather than a failure.
  return page
    .evaluate(() => document.documentElement.dataset.apiTarget ?? null)
    .catch(() => null)
}

async function mainTarget(page) {
  return page.evaluate(() => window.electronAPI.getApiTarget())
}

/** Call the API through whichever base URL is in force. Used for setup, not for proof. */
async function api(page, path, init) {
  return page.evaluate(
    async ([path, init]) => {
      const resolved = await window.electronAPI?.getApiTarget?.()
      const response = await fetch(`${resolved.baseUrl}${path}`, init ?? undefined)
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body }
    },
    [path, init ?? null],
  )
}

/** Reload and wait for whatever the app renders next (shell or wizard). */
async function reload(page) {
  await page.evaluate(() => window.location.reload())
  await waitFor('the reload to settle', async () => {
    const ready = await page.evaluate(() => document.readyState === 'complete').catch(() => false)
    return ready ? true : null
  })
  await waitForAppReady(page)
}

/** Set the remote account's onboarding flag, and confirm it stuck. */
async function setRemoteSetupCompleted(page, value) {
  // Retried, because `updateUserSettings` is a read-modify-write with no
  // atomicity: the wizard persists `onboardingProgress` on every step change,
  // and a mutation that read the row before this one lands will write its stale
  // copy back over the flag. One retry is enough — nothing else is writing by
  // the time the wizard is idle — but a bare single PUT is a coin flip.
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await api(page, '/api/user-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCompleted: value }),
    })
    expectEqual(response.status, 200, `user-settings PUT failed: ${JSON.stringify(response.body)}`)
    await page.waitForTimeout(500)
    const readBack = await api(page, '/api/user-settings')
    if (readBack.body?.setupCompleted === value) return
  }
  throw new Error(`setupCompleted would not stay ${value} on the deployment`)
}

/**
 * A fresh account on the deployment has not been onboarded, so the first switch
 * to cloud lands in the wizard. Finish it the way the wizard would.
 */
async function completeOnboarding(page) {
  await setRemoteSetupCompleted(page, true)
  await reload(page)
}

async function switchTo(page, target) {
  await page.click(`[data-testid="target-option-${target}"]`)
  await waitFor(
    `the renderer to come back on '${target}'`,
    async () => ((await rendererTarget(page).catch(() => null)) === target ? true : null),
    { timeoutMs: 90_000 },
  )
  await waitForAppReady(page)
}

async function waitForSwitcher(page) {
  await page.waitForSelector('[data-testid="target-switcher"]', { timeout: 60_000 })
}

async function openSettings(page) {
  await page.click('[data-testid="settings-button"]')
  await page.waitForSelector('[data-testid="global-settings-page"]', { timeout: 30_000 })
}

async function closeSettings(page) {
  await page.click('[data-testid="settings-back"]')
  await page.waitForSelector('[data-testid="app-sidebar"]', { timeout: 30_000 })
}

// ─── the run ────────────────────────────────────────────────────────────────

console.log(`stack:   proxy=${STACK.proxyUrl}  deployment=${STACK.deploymentUrl}`)
console.log(`appdata: ${DATA_DIR}`)
console.log(`cdp:     ${CDP_PORT}`)

resetDataDir(DATA_DIR)
seedDataDir(DATA_DIR)

let app = await launchApp({ dataDir: DATA_DIR })
let page = await app.mainPage()
await waitForAppReady(page)

const requestLog = []
const attachRequestLog = (target) => target.on('request', (req) => requestLog.push(req.url()))
attachRequestLog(page)

// Names are unique per run: the deployment outlives the run, so a fixed name
// accumulates duplicates there and a `text=` locator then matches several nodes.
const RUN_ID = String(Date.now()).slice(-6)
const LOCAL_AGENT = `Local Only ${RUN_ID}`
const CLOUD_AGENT = `Cloud Only ${RUN_ID}`

let localAgentSlug = null
let cloudAgentSlug = null

try {
  // ── A ─────────────────────────────────────────────────────────────────────
  group('A. Target resolution and the switch')

  await check('A1 boots local, with no fallback and no proxy prefix', async () => {
    const target = await mainTarget(page)
    expectEqual(target.target, 'local', 'boot target')
    expectEqual(target.fallback, null, 'fallback reason')
    expectEqual(target.baseUrl, `http://localhost:${app.apiPort}`, 'base URL')
  })

  await check('A2 the renderer itself reports local', async () => {
    expectEqual(await rendererTarget(page), 'local', 'document root target')
  })

  await check('A3 the switcher appears once the workspace is discovered', async () => {
    await waitForSwitcher(page)
    expectEqual(await rendererTarget(page), 'local', 'selected option')
  })

  await check('A4 an agent created locally lands in the local data dir', async () => {
    const created = await api(page, '/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: LOCAL_AGENT }),
    })
    expectEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`)
    localAgentSlug = created.body.slug
    expect(existsSync(join(DATA_DIR, 'agents', localAgentSlug)), `${localAgentSlug} missing locally`)
  })

  await check('A5 switching to cloud persists the preference', async () => {
    await page.click('[data-testid="target-option-cloud"]')
    await waitFor(
      'the preference to be written',
      () => (readSettings(DATA_DIR)?.apiTarget === 'cloud' ? true : null),
      { timeoutMs: 30_000 },
    )
  })

  await check('A6 the reloaded renderer settles on cloud', async () => {
    await waitFor(
      'the renderer to report cloud',
      async () => ((await rendererTarget(page).catch(() => null)) === 'cloud' ? true : null),
      { timeoutMs: 90_000 },
    )
  })

  await check('A7 the renderer talks to the loopback proxy, never the deployment', async () => {
    const { baseUrl } = await mainTarget(page)
    expect(
      baseUrl.startsWith(`http://localhost:${app.apiPort}/cloud/`),
      `expected the keyed loopback proxy prefix, got ${baseUrl}`,
    )
    expect(!baseUrl.includes('8899'), `base URL must not be the deployment origin: ${baseUrl}`)
  })

  await check('A8 the switcher shows cloud as the selected option', async () => {
    // The switcher lives in the shell, and a workspace whose account has never
    // been onboarded opens the wizard over it. Which of those you get depends on
    // whether this deployment has been switched to before — true of the one a
    // developer keeps around, false of the one CI stands up for a single run —
    // so arrange the shell rather than depending on the answer. B1 arranges the
    // opposite for itself, immediately after.
    await setRemoteSetupCompleted(page, true)
    await reload(page)
    await waitForSwitcher(page)
    expectEqual(
      await page.locator('[data-testid="target-option-cloud"]').getAttribute('aria-pressed'),
      'true',
      'aria-pressed on the cloud option',
    )
  })

  await check('A9 the launcher is torn down on the switch', async () => {
    await waitFor(
      'the quick-dispatch window to be destroyed',
      () => (app.pages().some((p) => p.url().includes('quick-dispatch.html')) ? null : true),
      { timeoutMs: 30_000 },
    )
  })

  // ── B ─────────────────────────────────────────────────────────────────────
  group('B. Onboarding lands on the remote workspace')

  await check('B1 a not-yet-onboarded remote account opens the wizard', async () => {
    // Arrange the precondition rather than depending on it. The deployment
    // outlives this run, so on every run after the first its account is already
    // onboarded and the wizard would never appear.
    await setRemoteSetupCompleted(page, false)
    await reload(page)
    await page.waitForSelector('[data-testid="wizard-container"]', { timeout: 30_000 })
  })

  await check('B2 the wizard offers no container-runtime step in cloud mode', async () => {
    // Phase 5's `stepsForPath` filter, observed live: the runtime step configures
    // a machine that is out of reach, so it must not appear. Walk every step.
    const seen = []
    for (let i = 0; i < 10; i++) {
      const text = await page.locator('[data-testid="wizard-step-content"]').innerText()
      seen.push(text.split('\n')[0])
      const next = page.locator('[data-testid="wizard-next"]')
      if (!(await next.count()) || !(await next.isEnabled())) break
      await next.click()
      await page.waitForTimeout(400)
    }
    expect(
      !seen.some((heading) => /container runtime/i.test(heading)),
      `the runtime step appeared in cloud mode: ${JSON.stringify(seen)}`,
    )
  })

  await check('B3 onboarding can be completed and the shell appears', async () => {
    await completeOnboarding(page)
    await page.waitForSelector('[data-testid="app-sidebar"]', { timeout: 30_000 })
    // The deployment outlives every run, so agents this harness created before
    // accumulate there. Clear the previous ones out — otherwise the sidebar fills
    // with near-identical rows and `hasText` locators stop being unambiguous.
    const listed = await api(page, '/api/agents')
    for (const agent of Array.isArray(listed.body) ? listed.body : []) {
      if (/^(Cloud Only|Local Only)\b/.test(agent.name) && agent.name !== CLOUD_AGENT) {
        await api(page, `/api/agents/${agent.slug}`, { method: 'DELETE' })
      }
    }
  })

  // ── C ─────────────────────────────────────────────────────────────────────
  group('C. Cloud mode really is the other machine')

  await check('C1 better-auth resolves a session through the proxy prefix', async () => {
    const session = await api(page, '/api/auth/get-session')
    expectEqual(session.status, 200, `get-session failed: ${JSON.stringify(session.body)}`)
    expect(session.body?.user?.email, 'expected an authenticated user from the deployment')
    const authCalls = requestLog.filter((url) => url.includes('/api/auth/get-session'))
    expect(authCalls.length > 0, 'the renderer never asked for a session')
    expect(
      authCalls.every((url) => url.includes('/cloud/')),
      `a session lookup escaped the proxy: ${authCalls.find((u) => !u.includes('/cloud/'))}`,
    )
  })

  await check('C2 the local agent is not visible in cloud mode', async () => {
    const listed = await api(page, '/api/agents')
    expectEqual(listed.status, 200, `list failed: ${JSON.stringify(listed.body)}`)
    const slugs = listed.body.map((agent) => agent.slug)
    expect(!slugs.includes(localAgentSlug), `cloud mode listed the local agent ${localAgentSlug}`)
  })

  await check('C3 an agent created in cloud mode lands on the deployment, not here', async () => {
    const created = await api(page, '/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CLOUD_AGENT }),
    })
    expectEqual(created.status, 201, `create failed: ${JSON.stringify(created.body)}`)
    cloudAgentSlug = created.body.slug
    expect(
      !existsSync(join(DATA_DIR, 'agents', cloudAgentSlug)),
      `${cloudAgentSlug} must NOT exist in the local data dir`,
    )
    if (NODE3_DATA) {
      expect(
        existsSync(join(NODE3_DATA, 'agents', cloudAgentSlug)),
        `${cloudAgentSlug} should exist in the deployment's data dir`,
      )
    }
  })

  await check('C4 the remote agent is the one rendered in the sidebar', async () => {
    // Created through a raw fetch, so nothing invalidated the agents query.
    await reload(page)
    await page.waitForSelector(`text=${CLOUD_AGENT}`, { timeout: 30_000 })
    expectEqual(
      await page.locator(`text=${LOCAL_AGENT}`).count(),
      0,
      'the local agent should not be listed in cloud mode',
    )
  })

  await check('C5 SSE streams through the proxy', async () => {
    const opened = await page.evaluate(async () => {
      const resolved = await window.electronAPI.getApiTarget()
      return new Promise((resolve) => {
        const source = new EventSource(`${resolved.baseUrl}/api/notifications/stream`)
        const done = (value) => {
          source.close()
          resolve(value)
        }
        source.onopen = () => done({ ok: true, url: source.url })
        source.onerror = () => done({ ok: false, url: source.url })
        setTimeout(() => done({ ok: false, url: source.url, timedOut: true }), 15_000)
      })
    })
    expect(opened.ok, `EventSource did not open: ${JSON.stringify(opened)}`)
    expect(opened.url.includes('/cloud/'), `SSE bypassed the proxy: ${opened.url}`)
  })

  await check('C6 no renderer request goes straight to the deployment origin', async () => {
    const escaped = requestLog.filter((url) => url.startsWith(STACK.deploymentUrl))
    expect(
      escaped.length === 0,
      `${escaped.length} request(s) bypassed the proxy:\n  ${escaped.slice(0, 5).join('\n  ')}`,
    )
  })

  // ── D ─────────────────────────────────────────────────────────────────────
  group('D. Capability gating, live')

  await check('D1 Computer Use is not offered in cloud mode', async () => {
    await openSettings(page)
    const settings = page.locator('[data-testid="global-settings-page"]')
    expectEqual(
      await settings.getByText('Computer Use', { exact: true }).count(),
      0,
      'the Computer Use tab should be withdrawn against a remote workspace',
    )
    await closeSettings(page)
  })

  await check('D2 the agent directory action degrades to copy-the-path', async () => {
    // The directory action lives in the agent header's settings popover
    // (moved there from the sidebar context menu).
    const row = page.locator('[data-testid^="agent-item-"]', { hasText: CLOUD_AGENT }).first()
    await row.click()
    await page.waitForSelector('[data-testid="agent-settings-button"]', { timeout: 15_000 })
    await page.click('[data-testid="agent-settings-button"]')
    await page.waitForSelector('[data-testid="open-agent-directory-item"]', { timeout: 15_000 })
    const label = await page.locator('[data-testid="open-agent-directory-item"]').innerText()
    expect(
      /copy agent directory path/i.test(label),
      `expected the copy action in cloud mode, got "${label}"`,
    )
    await page.keyboard.press('Escape')
  })

  // ── E ─────────────────────────────────────────────────────────────────────
  group('E. The preference survives a restart')

  await check('E1 relaunching stays on cloud', async () => {
    await app.close()
    app = await launchApp({ dataDir: DATA_DIR })
    page = await app.mainPage()
    attachRequestLog(page)
    await waitForAppReady(page)
    await waitFor(
      'the relaunched renderer to report cloud',
      async () => ((await rendererTarget(page).catch(() => null)) === 'cloud' ? true : null),
      { timeoutMs: 90_000 },
    )
  })

  await check('E2 the relaunched window still drives the cloud workspace', async () => {
    await waitForSwitcher(page)
    expectEqual(
      await page.locator('[data-testid="target-option-cloud"]').getAttribute('aria-pressed'),
      'true',
      'aria-pressed on the cloud option',
    )
  })

  await check('E3 the launcher is recreated, and carries its own marker', async () => {
    const launcher = await app.launcherPage({ timeoutMs: 60_000 })
    await launcher.waitForSelector('[data-testid="quick-dispatch-cloud-mode"]', { timeout: 30_000 })
  })

  // ── F ─────────────────────────────────────────────────────────────────────
  group('F. Returning to this computer')

  await check('F1 switching back lands on local', async () => {
    await switchTo(page, 'local')
    expectEqual((await mainTarget(page)).target, 'local', 'target after switching back')
    expectEqual(readSettings(DATA_DIR)?.apiTarget, 'local', 'persisted preference')
  })

  await check('F2 the local agent is back, and the remote one is gone', async () => {
    await page.waitForSelector(`text=${LOCAL_AGENT}`, { timeout: 30_000 })
    expectEqual(
      await page.locator(`text=${CLOUD_AGENT}`).count(),
      0,
      'the cloud agent leaked into the local list',
    )
  })

  await check('F3 the renderer reports local again', async () => {
    expectEqual(await rendererTarget(page), 'local', 'document root target')
  })

  await check('F4 Computer Use is offered again on this computer', async () => {
    await openSettings(page)
    const settings = page.locator('[data-testid="global-settings-page"]')
    expect(
      (await settings.getByText('Computer Use', { exact: true }).count()) > 0,
      'Computer Use should be available when driving this computer',
    )
    await closeSettings(page)
  })
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('\nfailed:')
  for (const f of failed) console.log(`  ${f.name}: ${String(f.error.message).split('\n')[0]}`)
  process.exit(1)
}
