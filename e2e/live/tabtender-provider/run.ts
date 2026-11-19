#!/usr/bin/env npx tsx
/**
 * Live check of the Tab Tender host-browser provider against a real Tab
 * Tender server: the provider class the app runs, and Playwright standing in
 * for the container, connecting to the URL the container is handed with no
 * headers, as agent-browser does.
 *
 *   TABTENDER_URL=http://127.0.0.1:3000 TABTENDER_API_KEY=tt_... npm run test:live:tabtender-provider
 *
 * With AGENT_BROWSER_BIN=<path to the agent-browser the container pins>, it
 * also drives the browser with that CLI.
 *
 * It checks: the container's URL carries a session token and not the key; a
 * page loads and runs on it; a reopen hands back the same browser; the live
 * session is adopted after an "app restart" (a fresh provider); a stop ends
 * the session and its URL stops working; what a page stored survives into a
 * new session on the agent's profile. Every session it opens is ended before
 * it exits, pass or fail; the profile it used is left on the server
 * (`superagent-tabtender-live-<run>`).
 *
 * (Run from the same machine as the server, a loopback URL is fine here; the
 * app refuses one because agent containers cannot reach it.)
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'

const baseUrl = process.env.TABTENDER_URL
const apiKey = process.env.TABTENDER_API_KEY
if (!baseUrl || !apiKey) {
  console.error('TABTENDER_URL and TABTENDER_API_KEY are required')
  process.exit(2)
}
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tabtender-provider-live-'))
process.env.SUPERAGENT_DATA_DIR = dataDir

const started = Date.now()
const log = (message: string) => console.log(`[tabtender-live ${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`)
const pass = (message: string) => log(`PASS ${message}`)
const run = promisify(execFile)

// Imported once the data dir is set: the database module reads it.
async function load() {
  return {
    db: await import('../../../src/shared/lib/db'),
    appState: await import('../../../src/shared/lib/app-state'),
    provider: await import('../../../src/main/host-browser/tabtender-provider'),
    api: await import('../../../src/main/host-browser/tabtender-api'),
  }
}

async function check(modules: Awaited<ReturnType<typeof load>>): Promise<void> {
  const { TabtenderProvider, tabtenderProfileName } = modules.provider
  const api = new modules.api.TabtenderApi(baseUrl!, apiKey!)
  const agentId = `tabtender-live-${Date.now().toString(36)}`
  const profile = tabtenderProfileName(agentId)

  let provider = new TabtenderProvider()
  const status = await provider.detect()
  assert.equal(status.available, true, `provider unavailable: ${status.reason}`)

  // 1. Launch: the container gets the session's CDP URL with its token, never the key.
  const info = await provider.launch(agentId, {}, agentId)
  assert.ok(info.cdpUrl, 'no cdpUrl')
  assert.match(info.cdpUrl, /[?&]token=[A-Za-z0-9_-]{43}/)
  assert.ok(!info.cdpUrl.includes(apiKey!), 'key leaked to the container')
  const live = (await api.listSessions()).filter((s) => s.profile === profile)
  assert.equal(live.length, 1)
  pass(`launch opened ${live[0].id} on ${profile}; container URL carries a session token, not the key`)

  // 2. A CDP client with the bare URL and no headers drives a page.
  let browser = await chromium.connectOverCDP(info.cdpUrl)
  let context = browser.contexts()[0] ?? await browser.newContext()
  let page = await context.newPage()
  await page.goto('https://example.com')
  assert.match(await page.title(), /Example Domain/)
  await page.evaluate(() => localStorage.setItem('superagent-live', 'kept'))
  await context.addCookies([{ name: 'sa_live', value: 'cookie-kept', domain: 'example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }])
  pass('page loaded and ran with no headers; stored a localStorage item and a cookie')

  // 3. A reopen while it runs is the same browser (same URL, no new session).
  const again = await provider.launch(agentId, {}, agentId)
  assert.equal(again.cdpUrl, info.cdpUrl)
  assert.equal((await api.listSessions()).filter((s) => s.profile === profile).length, 1)
  pass('reopen handed back the same URL')
  await browser.close() // disconnects; the session keeps running

  // 3b. The container's own CLI, when given: `--cdp <url>` as server.ts passes it.
  const agentBrowser = process.env.AGENT_BROWSER_BIN
  if (agentBrowser) {
    const ab = async (...args: string[]) => (await run(agentBrowser, ['--session', agentId, '--cdp', info.cdpUrl!, ...args], { timeout: 60_000 })).stdout.trim()
    await ab('open', 'https://example.com')
    assert.match(await ab('get', 'title'), /Example Domain/)
    assert.match(await ab('snapshot', '-i', '-c'), /Learn more|More information/)
    await run(agentBrowser, ['--session', agentId, 'close'], { timeout: 30_000 }).catch(() => { /* daemon already gone */ })
    pass('agent-browser opened, read and snapshotted a page')
  }

  // 4. An app restart: a fresh provider adopts the live session holding the profile, same URL.
  provider = new TabtenderProvider()
  const adopted = await provider.launch(agentId, {}, agentId)
  assert.equal(adopted.cdpUrl, info.cdpUrl)
  assert.deepEqual((await api.listSessions()).filter((s) => s.profile === profile).map((s) => s.id), live.map((s) => s.id))
  pass(`a fresh provider adopted ${live[0].id} instead of opening a second browser`)

  // 5. Stop ends the session, and its URL stops working.
  // Give Chrome a moment to flush the profile to disk before it is shut down.
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  await provider.stop(agentId)
  assert.equal((await api.getSession(live[0].id)).status, 'terminated')
  await assert.rejects(chromium.connectOverCDP(info.cdpUrl, { timeout: 5_000 }))
  pass('stop ended the session on the server, and its URL is refused')

  // 6. A new session on the agent's profile has what the last one stored.
  const next = await provider.launch(agentId, {}, agentId)
  assert.notEqual(next.cdpUrl, info.cdpUrl)
  browser = await chromium.connectOverCDP(next.cdpUrl!)
  context = browser.contexts()[0]
  const cookies = await context.cookies('https://example.com')
  assert.equal(cookies.find((c) => c.name === 'sa_live')?.value, 'cookie-kept')
  page = await context.newPage()
  await page.goto('https://example.com')
  assert.equal(await page.evaluate(() => localStorage.getItem('superagent-live')), 'kept')
  await browser.close()
  pass('a new session on the profile kept the cookie and the localStorage item')

  await provider.stopAll()
  assert.equal((await api.listSessions()).filter((s) => s.profile === profile).length, 0)
  pass('stopAll ended every session')
}

async function main(): Promise<number> {
  const modules = await load()
  await modules.db.openDatabase()
  await modules.appState.initializeLocalAppState()
  try {
    await check(modules)
    log('ALL PASSED')
    return 0
  } catch (error) {
    console.error('[tabtender-live] FAILED:', error)
    return 1
  } finally {
    // End anything this run left open on the server.
    try {
      const api = new modules.api.TabtenderApi(baseUrl!, apiKey!)
      for (const session of await api.listSessions()) {
        if (session.profile?.startsWith('superagent-tabtender-live-')) await api.deleteSession(session.id)
      }
    } catch { /* best effort */ }
    await modules.db.closeDatabase().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error(error)
  process.exit(1)
})
