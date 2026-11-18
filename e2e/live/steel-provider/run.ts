#!/usr/bin/env npx tsx
/**
 * Live check of the Steel host-browser provider against the real Steel cloud
 * API: the provider class the app runs, a real database for the agent→profile
 * mappings, and CDP clients standing in for the container (agent-browser and
 * the live-view screencast).
 *
 *   STEEL_API_KEY=ste-... npm run test:live:steel-provider
 *
 * Every session it creates is released before it exits, pass or fail. Each
 * run creates two Steel profiles (Steel deletes them after 30 days unused).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const apiKey = process.env.STEEL_API_KEY
if (!apiKey) {
  console.error('STEEL_API_KEY is required')
  process.exit(2)
}
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'steel-provider-live-'))
process.env.SUPERAGENT_DATA_DIR = dataDir

// Imported once the data dir is set: the database module reads it.
type Modules = {
  db: typeof import('../../../src/shared/lib/db')
  appState: typeof import('../../../src/shared/lib/app-state')
  provider: typeof import('../../../src/main/host-browser/steel-provider')
  api: typeof import('../../../src/main/host-browser/steel-api')
  mappings: typeof import('../../../src/main/host-browser/context-map-store')
}
async function load(): Promise<Modules> {
  return {
    db: await import('../../../src/shared/lib/db'),
    appState: await import('../../../src/shared/lib/app-state'),
    provider: await import('../../../src/main/host-browser/steel-provider'),
    api: await import('../../../src/main/host-browser/steel-api'),
    mappings: await import('../../../src/main/host-browser/context-map-store'),
  }
}

const created = new Set<string>()
const started = Date.now()
const log = (message: string) => console.log(`[steel-live ${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`)
const pass = (message: string) => log(`PASS ${message}`)

/** A CDP client on a browser-level endpoint, attached to its first page (flattened sessions). */
class Cdp {
  private nextId = 0
  private pending = new Map<number, (message: { result?: Record<string, unknown>; error?: { message: string } }) => void>()
  private listeners: Array<(message: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void> = []
  pageSession = ''

  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)!(message)
        this.pending.delete(message.id)
      } else {
        for (const listener of this.listeners) listener(message)
      }
    })
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    const cdp = new Cdp(ws)
    const targets = await cdp.send('Target.getTargets')
    const page = (targets.targetInfos as Array<{ type: string; targetId: string }>).find((t) => t.type === 'page')
    assert.ok(page, 'the session has a page')
    cdp.pageSession = String((await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId)
    return cdp
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId
    const reply = await new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000)
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
    return reply.result ?? {}
  }

  page(method: string, params: Record<string, unknown> = {}) {
    return this.send(method, params, this.pageSession)
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return (result.result as { value?: unknown } | undefined)?.value
  }

  async navigate(url: string) {
    await this.page('Page.enable')
    const loaded = this.next('Page.loadEventFired', 20_000)
    await this.page('Page.navigate', { url })
    await loaded
  }

  next(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${method} within ${timeoutMs} ms`)), timeoutMs)
      const listener = (message: { method?: string; params?: Record<string, unknown> }) => {
        if (message.method !== method) return
        clearTimeout(timer)
        this.listeners = this.listeners.filter((l) => l !== listener)
        resolve(message.params ?? {})
      }
      this.listeners.push(listener)
    })
  }

  close() { this.ws.close() }
}

/** The session a Steel CDP URL connects to (`wss://connect.steel.dev?sessionId=…&token=…`). */
const sessionIdOf = (cdpUrl: string) => {
  const id = cdpUrl.match(/[?&]sessionId=([^&]+)/)?.[1]
  assert.ok(id, 'the CDP URL names its session')
  return id
}

async function track(cdpUrl: string) {
  const id = sessionIdOf(cdpUrl)
  created.add(id)
  return id
}

async function run({ db, appState, provider: { SteelProvider }, mappings: { getOrCreateMapping, readContextMapping } }: Modules, steel: InstanceType<Modules['api']['SteelApi']>) {
  await db.openDatabase()
  await appState.initializeLocalAppState()
  const provider = new SteelProvider()

  assert.equal((await provider.detect()).available, true)
  pass('detect: available with the key from STEEL_API_KEY')

  // 1. First browser: creates the profile and maps it.
  const first = await provider.launch('live-a', {}, 'live-a')
  assert.ok(first.cdpUrl)
  const firstSession = await track(first.cdpUrl)
  assert.ok(!first.cdpUrl.includes(apiKey!), 'the CDP URL does not carry the API key')
  const profileA = await readContextMapping('steel', 'live-a')
  assert.ok(profileA, 'the profile is mapped')
  const firstInfo = await steel.getSession(firstSession)
  assert.equal(firstInfo.status, 'live')
  assert.equal(firstInfo.profileId, profileA)
  pass(`launch: session ${firstSession} on new profile ${profileA}, URL signed per session`)

  // 2. The container's connections: agent-browser and the screencast at once.
  const agent = await Cdp.open(first.cdpUrl)
  const viewer = await Cdp.open(first.cdpUrl)
  await agent.navigate('https://example.com/')
  assert.equal(await agent.evaluate('document.title'), 'Example Domain')
  await agent.evaluate(`document.cookie = "steel_live=persisted; max-age=86400; path=/"; localStorage.setItem("steel_live", "kept"); true`)
  const framePromise = viewer.next('Page.screencastFrame', 20_000)
  await viewer.page('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 800 })
  const frame = await framePromise
  assert.ok(String(frame.data).length > 1000, 'a screencast frame arrives')
  pass('two CDP clients at once: navigation in one, screencast frame in the other')

  // 3. Another open while live: same browser, same URL.
  const again = await provider.launch('live-a', {}, 'live-a')
  assert.equal(again.cdpUrl, first.cdpUrl)
  assert.equal(await agent.evaluate('location.href'), 'https://example.com/')
  pass('relaunch while live: same session and URL, page untouched')

  // 4. Clients disconnecting do not end the session.
  agent.close()
  viewer.close()
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  assert.equal((await steel.getSession(firstSession)).status, 'live')
  pass('the session outlives its CDP clients')

  // 5. Stop releases; the next browser opens on the saved profile.
  await provider.stop('live-a')
  assert.equal((await steel.getSession(firstSession)).status, 'released')
  const second = await provider.launch('live-a', {}, 'live-a')
  const secondSession = await track(second.cdpUrl!)
  assert.notEqual(secondSession, firstSession)
  assert.equal((await steel.getSession(secondSession)).profileId, profileA)
  const reader = await Cdp.open(second.cdpUrl!)
  await reader.navigate('https://example.com/')
  assert.equal(await reader.evaluate('document.cookie'), 'steel_live=persisted')
  assert.equal(await reader.evaluate('localStorage.getItem("steel_live")'), 'kept')
  // This session loaded the profile; what it changes must be saved too.
  await reader.evaluate(`document.cookie = "steel_live2=second; max-age=86400; path=/"; true`)
  reader.close()
  pass(`stop + relaunch: session ${secondSession} restored the cookie and localStorage from the profile`)

  // 6. The app restarts: a new provider finds the live session on the profile.
  const restarted = new SteelProvider()
  const adopted = await restarted.launch('live-a', {}, 'live-a')
  assert.equal(sessionIdOf(adopted.cdpUrl!), secondSession)
  const adoptedClient = await Cdp.open(adopted.cdpUrl!)
  assert.equal(await adoptedClient.evaluate('location.href'), 'https://example.com/')
  adoptedClient.close()
  pass('after a restart: the live session on the profile is used again, not a second one opened')

  // 7. Stop and reopen at once: the launch waits for Steel to save the loading
  // session's changes (a session opened before the save loads the older state).
  await restarted.stop('live-a')
  const saveWaitStarted = Date.now()
  const third = await restarted.launch('live-a', {}, 'live-a')
  const thirdSession = await track(third.cdpUrl!)
  const saveWaitMs = Date.now() - saveWaitStarted
  const thirdReader = await Cdp.open(third.cdpUrl!)
  await thirdReader.navigate('https://example.com/')
  assert.equal(await thirdReader.evaluate('document.cookie'), 'steel_live=persisted; steel_live2=second')
  thirdReader.close()
  pass(`immediate reopen: session ${thirdSession} has both sessions' cookies (launch took ${saveWaitMs} ms, incl. the save wait)`)

  // The app restarts again, and the container asks to stop the browser it kept using.
  await new SteelProvider().stop('live-a')
  assert.equal((await steel.getSession(thirdSession)).status, 'released')
  pass('after a restart, a stop releases the live session on the profile that this process never opened')

  // 8. A mapped profile Steel no longer has is replaced.
  const gone = '00000000-0000-4000-8000-000000000000'
  await getOrCreateMapping('steel', 'live-b', async () => gone)
  const replaced = await restarted.launch('live-b', {}, 'live-b')
  await track(replaced.cdpUrl!)
  const profileB = await readContextMapping('steel', 'live-b')
  assert.ok(profileB && profileB !== gone)
  assert.equal((await steel.getSession(sessionIdOf(replaced.cdpUrl!))).profileId, profileB)
  pass(`missing profile ${gone} replaced by ${profileB}`)

  // 9. Shutdown releases everything.
  await restarted.stopAll()
  await provider.stopAll()
  for (const id of created) assert.notEqual((await steel.getSession(id)).status, 'live', `${id} released`)
  pass(`stopAll: all ${created.size} sessions released`)
}

async function main(): Promise<number> {
  const modules = await load()
  const steel = new modules.api.SteelApi(apiKey!)
  try {
    await run(modules, steel)
    log('ALL PASSED')
    return 0
  } catch (error) {
    console.error('[steel-live] FAILED:', error)
    return 1
  } finally {
    // Everything this run opened, including a session a failed step never got to track.
    const profiles = new Set<string>()
    for (const key of ['live-a', 'live-b']) {
      const profile = await modules.mappings.readContextMapping('steel', key).catch(() => null)
      if (profile) profiles.add(profile)
    }
    for (const profile of profiles) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const holder = await steel.findLiveSessionOnProfile(profile).catch(() => null)
        if (!holder) break
        created.add(holder.id)
        await steel.releaseSession(holder.id).catch(() => {})
      }
    }
    for (const id of created) {
      await steel.releaseSession(id).catch(() => {})
    }
    await modules.db.closeDatabase().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error('[steel-live] FAILED:', error)
  process.exit(1)
})
