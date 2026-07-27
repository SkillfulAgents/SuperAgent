/**
 * Watch a target switch happen, in detail.
 *
 * `run.mjs` tells you *that* something broke; this tells you what the app was
 * doing at the time. It logs every request, response, page error and navigation
 * across the switch, and samples what is on screen as it goes — which is how the
 * better-auth base-URL bug was found: the suite could only report "the sidebar
 * never appeared", while this showed a single 404 on
 * `/cloud/{key}/get-session`, an auth path with its `/api/auth` missing.
 *
 *   node e2e/live/cloud-electron/inspect.mjs
 */

import { join } from 'node:path'
import { launchApp, seedDataDir, resetDataDir, waitForAppReady, waitFor } from './harness.mjs'

const dataDir = process.env.LIVE_APP_DATA_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'cloud-live-app')
const SAMPLES = Number(process.env.LIVE_INSPECT_SAMPLES ?? 6)

resetDataDir(dataDir)
seedDataDir(dataDir)

const app = await launchApp({ dataDir })
const page = await app.mainPage()

let t0 = Date.now()
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`
const events = []
const redact = (url) => url.replace(/\/cloud\/[^/]+/, '/cloud/<key>')

page.on('response', (res) => events.push(`${stamp()} ${res.status()} ${redact(res.url())}`))
page.on('requestfailed', (req) =>
  events.push(`${stamp()} FAILED ${redact(req.url())} ${req.failure()?.errorText}`),
)
page.on('pageerror', (error) => events.push(`${stamp()} PAGEERROR ${error.message.slice(0, 300)}`))
page.on('console', (msg) => {
  if (msg.type() === 'error') events.push(`${stamp()} console.error ${msg.text().slice(0, 200)}`)
})
page.on('framenavigated', (frame) => {
  if (!frame.parentFrame()) events.push(`${stamp()} NAVIGATED ${frame.url()}`)
})

async function snapshot(label) {
  const info = await page
    .evaluate(() => ({
      testids: [...document.querySelectorAll('[data-testid]')]
        .map((el) => el.getAttribute('data-testid'))
        .slice(0, 30),
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    }))
    .catch((error) => ({ unavailable: error.message }))
  console.log(`\n=== ${label} ===`)
  console.log('testids:', (info.testids ?? []).join(', '))
  console.log('text:   ', JSON.stringify(info.text ?? info.unavailable))
}

await waitForAppReady(page)
await page.waitForSelector('[data-testid="target-switcher"]', { timeout: 60_000 })
await snapshot('before the switch')

console.log('\n--- clicking Cloud ---')
t0 = Date.now()
events.length = 0
await page.click('[data-testid="target-option-cloud"]')

for (let i = 0; i < SAMPLES; i++) {
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const shown = await page
    .evaluate(() => ({
      reconnect: document.body.innerText.includes('reach your cloud workspace'),
      wizard: !!document.querySelector('[data-testid="wizard-container"]'),
      sidebar: !!document.querySelector('[data-testid="app-sidebar"]'),
      marker: !!document.querySelector('[data-testid="cloud-mode-indicator"]'),
    }))
    .catch(() => ({ evaluating: 'unavailable' }))
  console.log(`${stamp()} ${JSON.stringify(shown)}`)
}

await snapshot('after the switch')
console.log('\n--- traffic ---')
for (const line of events) console.log(line)
console.log('\nwindows:', app.pages().map((p) => p.url()))

await app.close()
