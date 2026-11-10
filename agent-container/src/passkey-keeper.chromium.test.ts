// Real-Chromium tests for the passkey keeper: a page on localhost (a secure
// context) creates and asserts passkeys through navigator.credentials, as a
// site does, while the keeper holds a virtual authenticator on its tab.
// Playwright drives the page over a session of its own that stays attached,
// as agent-browser's does. Skipped when no Chromium is installed.
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { CdpConnection } from './login-cdp'
import { PasskeyKeeper, signCountNow } from './passkey-keeper'

function findChromium(): string | null {
  const candidates = [
    process.env.LOGIN_TEST_CHROMIUM,
    (() => { try { return chromium.executablePath() } catch { return undefined } })(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate)) ?? null
}

const CHROMIUM = findChromium()

/** reg() creates a discoverable passkey; auth() asserts one; both say what happened and never hang. */
const SITE = `<!doctype html><title>Passkeys</title><body>site
<script>
const flags = (authData) => {
  const d = new Uint8Array(authData)
  return { uv: !!(d[32] & 4), be: !!(d[32] & 8), bs: !!(d[32] & 16), signCount: (d[33] << 24 | d[34] << 16 | d[35] << 8 | d[36]) >>> 0 }
}
window.reg = async (ms = 4000) => {
  try {
    const cred = await navigator.credentials.create({ signal: AbortSignal.timeout(ms), publicKey: {
      rp: { id: 'localhost', name: 'Site' },
      user: { id: new TextEncoder().encode('user-octocat'), name: 'octocat', displayName: 'Octocat' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    } })
    return { ok: true, id: cred.id }
  } catch (e) { return { ok: false, error: e.name } }
}
window.auth = async (ms = 4000) => {
  try {
    const cred = await navigator.credentials.get({ signal: AbortSignal.timeout(ms), publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', userVerification: 'required',
    } })
    return { ok: true, id: cred.id, ...flags(cred.response.authenticatorData) }
  } catch (e) { return { ok: false, error: e.name } }
}
</script>`

/** A credential id as the page's PublicKeyCredential.id shows it (base64url, no padding). */
const asPageId = (base64: string) => base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe.skipIf(!CHROMIUM)('the passkey keeper in real Chromium', { timeout: 30_000 }, () => {
  let server: http.Server
  let port = 0
  let userDataDir = ''
  let devtools = ''
  let browserWs = ''
  let context: BrowserContext
  let page: Page
  let keeper: PasskeyKeeper

  const pageTarget = async () => {
    const targets = await (await fetch(`${devtools}/json/list`)).json() as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }>
    const target = targets.find((t) => t.type === 'page' && t.url === page.url())
    if (!target) throw new Error('page target not found')
    return target
  }

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(SITE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkey-chromium-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROMIUM!,
      headless: true,
      args: ['--no-sandbox', '--remote-debugging-port=0'],
    })
    const portFile = path.join(userDataDir, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    const [devtoolsPort, browserPath] = fs.readFileSync(portFile, 'utf8').split('\n')
    devtools = `http://127.0.0.1:${devtoolsPort}`
    browserWs = `ws://127.0.0.1:${devtoolsPort}${browserPath}`
    page = context.pages()[0] ?? await context.newPage()
    await page.goto(`http://localhost:${port}/`)
  }, 60_000)

  afterEach(async () => {
    await keeper?.disarm()
  })

  afterAll(async () => {
    await context?.close().catch(() => {})
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  const newKeeper = () => {
    keeper = new PasskeyKeeper({ connectBrowser: () => CdpConnection.openBrowser(browserWs) })
    return keeper
  }

  it('keeps the passkey a page creates, private key and all, and answers with it after', async () => {
    const k = newKeeper()
    // Without one, no passkey is made (Chrome headless refuses at once; others wait for a key that never comes).
    expect(await page.evaluate('reg(1500)')).toMatchObject({ ok: false })
    await k.arm({ targetId: (await pageTarget()).id, mode: 'record', ttlMs: 60_000 })
    const made = await page.evaluate('reg()') as { ok: boolean; id: string }
    expect(made.ok).toBe(true)
    const created = await k.takeCreated(2_000)
    expect(created).toMatchObject({ rpId: 'localhost', userName: 'octocat' })
    expect(asPageId(created!.credentialId)).toBe(made.id)
    expect(created!.privateKey.length).toBeGreaterThan(100)
    // Taken once.
    expect(await k.takeCreated(50)).toBeNull()
    expect(await page.evaluate('auth()')).toMatchObject({ ok: true, id: made.id })
  })

  it('holds a saved passkey for a sign-in, with a sign count that only goes up, and lets go of it when disarmed', async () => {
    const k = newKeeper()
    await k.arm({ targetId: (await pageTarget()).id, mode: 'record', ttlMs: 60_000 })
    await page.evaluate('reg()')
    const saved = (await k.takeCreated(2_000))!
    await k.disarm()

    await k.arm({ targetId: (await pageTarget()).id, mode: 'present', credentials: [saved], ttlMs: 60_000 })
    const used = await page.evaluate('auth()') as { ok: boolean; id: string; uv: boolean; be: boolean; bs: boolean; signCount: number }
    expect(used).toMatchObject({ ok: true, id: asPageId(saved.credentialId), uv: true, be: true, bs: true })
    expect(used.signCount).toBeGreaterThanOrEqual(signCountNow(0) - 5)
    // The event comes a moment after the page has its answer.
    await expect.poll(() => k.state().asserted).toEqual([saved.credentialId])

    await k.disarm()
    expect(await page.evaluate('auth(1500)')).toMatchObject({ ok: false })
  })

  it('arms the tab again after another DevTools session attaches to it and leaves', async () => {
    const k = newKeeper()
    await k.arm({ targetId: (await pageTarget()).id, mode: 'record', ttlMs: 60_000 })
    await page.evaluate('reg()')
    const saved = (await k.takeCreated(2_000))!
    // As our fills and captures do: a page connection of its own, then closed.
    const target = await pageTarget()
    const other = await CdpConnection.open({ id: target.id, wsUrl: target.webSocketDebuggerUrl, requiresSession: false })
    other.close()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await page.evaluate('auth()')).toMatchObject({ ok: true, id: asPageId(saved.credentialId) })
  })

  it('lets go of the tab when its time is up', async () => {
    const k = newKeeper()
    await k.arm({ targetId: (await pageTarget()).id, mode: 'record', ttlMs: 300 })
    expect(k.state()).toMatchObject({ armed: true, mode: 'record' })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(k.state().armed).toBe(false)
    expect(await page.evaluate('reg(1500)')).toMatchObject({ ok: false })
  })
})

describe('signCountNow', () => {
  it('is the seconds since 1970, never less than the stored count', () => {
    expect(signCountNow(0, 1_800_000_000_500)).toBe(1_800_000_000)
    expect(signCountNow(1_900_000_000, 1_800_000_000_500)).toBe(1_900_000_000)
  })
})
