// Real-Chromium tests for add_sign_in_method's page side: reading an
// authenticator app's setup from a QR code (in view, further down the page,
// or the one a ref names), an otpauth link, or a key the page keeps to type.
// Playwright stands in for agent-browser (it reports a ref's box), as in
// login-fill.chromium.test.ts. Skipped when no Chromium is installed.
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import { decodeQr, readAuthenticatorSetup } from './authenticator-setup'
import { CdpConnection } from './login-cdp'
import type { LoginFillDeps } from './login-fill'

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

const SETUP_URI = 'otpauth://totp/Acme:alice%40vault.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme'

/** A QR code of SETUP_URI (qrcode-generator, 4 px modules). */
const SETUP_QR =
  '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' +
  'dgAAAABJRU5ErkJggg=='

/** A QR code of an app-store link: not a setup. */
const APP_QR =
  'iVBORw0KGgoAAAANSUhEUgAAAHwAAAB8CAYAAACrHtS+AAAACXBIWXMAAAsTAAALEwEAmpwYAAADT0lEQVR4nO3Z0a4bIQyE4Xn/l6aX7SZq6JyxgYZ/pL1i' +
  'Fxt/RKp6NMhV0e4GyNoAflkAvx1c0tInrV/d/2tm6262z/e4hgAfgAM+AAd8tIBXp3vA1QOaxf1++3yPawjwKIAD/gjgAtwCcQeY7p8OQIsvVPX54/2Pawjw' +
  'ATjgA/B/DOCHg7v13CjstxrUrQe4GQF+VkNuPTcC/KyG3HpuBPhhDZn7dwNUX8Dt8z2uIcAH4IAPwAEfS8DTVA+4+oK8phu0OoAD/gjgkwDe3NDsfcCbwVcP' +
  '/LZ1rZ7vcQ1dti7A71oX4Hetazf4aVl9Yb49x58Y8Nocf2LAa3P8iQGvTfwfL7v/EbK6v+4L5u5n91vdIODPAA74xwAOeC/42wvNILN6aX/p/rNUX4jq99++' +
  'dw8E+DOAhwFcgCf9pft/PXh1A9XP7gu1u17cz2xDwAW48z7gAhzwLwafNhC+3/29ii/o6vm8rXcPpPtAgD8DePP5BDjgugncbcj9Pt1fxfVm9d3+2uunDQH+' +
  'DODh/m4AF+CA/05c4fSBVtdTWN+9kOnzVn/1QKrruetuAA8HUl3PXXcDeDiQ6nruupuvB483XDwQNwr3q+5v+XyrDwS4AE/WAX8GcDMC3PuguoE0LoCaB+r2' +
  'u3w9PRDgXgAPA/gzgAP+yLTjdGDdTxoVA57+gwFcgH8sCPgzgAM+/ivwtIHuAaTvu1l9IdvnmxYsbwjwAXjh+24AB3x8NXg1YPeBVtdX8Ty6fzCAvwRwwAfg' +
  'gN8DnhZM65UPQLUXLO23uz/ABTjgAhzwH+Z68O4BVPev8EKufqbncxt2B+auu/sDLsAB/3sAvx18d7oBV4O7Sc873X8cFsAFOOACHPCfJf7jSfq49acHKgZS' +
  'cb/d558FcAEO+B8BHPDvBq9OeuDqC/aa1Rd0tl/5++kGbgD/HMAB/xjAAa8FTwdcvd7dzyzdF7T6Bwi4AAfcCOCAD8CD/d310y9I94Wbvu9uALgAB/znARzw' +
  'u8Dderv7V3M/5f3vHtgsgD8D+Ob+BTjgXwWeJgV33++uN0s1YHzB3A/SAP4M4MXvA/4M4C+5Hrz7cRt2+939vZrP7wZwAQ64AAf8L9l9fjf1O5KjA/hlAfyy' +
  'AD7uyi+f/Oq0Q6t+jAAAAABJRU5ErkJggg=='

const qrImage = (png: string, attributes = '') => `<img ${attributes} alt="QR code" src="data:image/png;base64,${png}">`

const PAGES: Record<string, string> = {
  '/qr.html': `<!doctype html><title>Set up</title><h1>Set up an authenticator app</h1>${qrImage(SETUP_QR)}
    <label for="c">Code from the app</label><input id="c" inputmode="numeric">`,
  '/below.html': `<!doctype html><title>Set up</title><div style="height: 2400px">Scroll down</div>${qrImage(SETUP_QR)}`,
  '/two.html': `<!doctype html><title>Set up</title>${qrImage(APP_QR, 'id="app"')}<p>Get our app</p>${qrImage(SETUP_QR, 'id="setup"')}`,
  '/app-only.html': `<!doctype html><title>Get the app</title>${qrImage(APP_QR)}`,
  '/link.html': `<!doctype html><title>Set up</title><a href="${SETUP_URI}">Open in your authenticator app</a>`,
  '/key.html': `<!doctype html><title>Set up</title><p>Scan the code, or <button>Can't scan it?</button></p>
    <div hidden><code>jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp</code></div>`,
  '/none.html': `<!doctype html><title>Security</title><p>Two-factor authentication is off.</p><code>ORDER 2024 ABCD EFGH</code>`,
}

describe('decodeQr', () => {
  it('reads the text of a QR code image', async () => {
    expect(await decodeQr(Buffer.from(SETUP_QR, 'base64'))).toBe(SETUP_URI)
    expect(await decodeQr(Buffer.from(APP_QR, 'base64'))).toBe('https://example.com/get-the-app')
  })
})

describe.skipIf(!CHROMIUM)('reading an authenticator setup in real Chromium', { timeout: 30_000 }, () => {
  let server: http.Server
  let port = 0
  let userDataDir = ''
  let devtools = ''
  let context: BrowserContext
  let page: Page
  const refs = new Map<string, Locator>()

  const deps: Pick<LoginFillDeps, 'connect' | 'boxOfRef'> = {
    boxOfRef: async (ref) => {
      const locator = refs.get(ref)
      if (!locator) return null
      return locator.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
    },
    connect: async () => {
      const targets = await (await fetch(`${devtools}/json/list`)).json() as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }>
      const target = targets.find((t) => t.type === 'page' && t.url === page.url())
      if (!target) throw new Error('page target not found')
      return CdpConnection.open({ id: target.id, wsUrl: target.webSocketDebuggerUrl, requiresSession: false })
    },
  }

  const open = async (pathname: string) => {
    await page.goto(`http://127.0.0.1:${port}${pathname}`)
    refs.clear()
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' })
      res.end(body ?? 'not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authenticator-chromium-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROMIUM!,
      headless: true,
      args: ['--no-sandbox', '--remote-debugging-port=0'],
    })
    const portFile = path.join(userDataDir, 'DevToolsActivePort')
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    devtools = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').split('\n')[0]}`
    page = context.pages()[0] ?? await context.newPage()
  }, 60_000)

  afterAll(async () => {
    await context?.close().catch(() => {})
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  it('reads the QR code in view', async () => {
    await open('/qr.html')
    expect(await readAuthenticatorSetup(deps, { qrRef: null })).toEqual({ ok: true, key: SETUP_URI, source: 'qr' })
  })

  it('reads a QR code further down the page', async () => {
    await open('/below.html')
    expect(await readAuthenticatorSetup(deps, { qrRef: null })).toEqual({ ok: true, key: SETUP_URI, source: 'qr' })
  })

  it('reads the QR code a ref names, and says when it is not a setup', async () => {
    await open('/two.html')
    refs.set('@e1', page.locator('#setup'))
    refs.set('@e2', page.locator('#app'))
    expect(await readAuthenticatorSetup(deps, { qrRef: '@e1' })).toEqual({ ok: true, key: SETUP_URI, source: 'qr' })
    expect(await readAuthenticatorSetup(deps, { qrRef: '@e2' })).toEqual({ ok: false, problem: 'the QR code at @e2 does not set up an authenticator app' })
  })

  it('reads an otpauth link the page offers phones', async () => {
    await open('/link.html')
    expect(await readAuthenticatorSetup(deps, { qrRef: null })).toEqual({ ok: true, key: SETUP_URI, source: 'link' })
  })

  it('reads the key the page keeps behind "Can\'t scan it?", without opening it', async () => {
    await open('/key.html')
    expect(await readAuthenticatorSetup(deps, { qrRef: null })).toEqual({ ok: true, key: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', source: 'text' })
  })

  it('says what it saw on a page with no setup', async () => {
    await open('/app-only.html')
    expect(await readAuthenticatorSetup(deps, { qrRef: null })).toEqual({
      ok: false,
      problem: 'the QR code on the page does not set up an authenticator app: pass the setup QR code\'s ref as qr',
    })
    await open('/none.html')
    expect(await readAuthenticatorSetup(deps, { qrRef: null })).toEqual({
      ok: false,
      problem: 'no QR code or setup key for an authenticator app was found on the page: open the step that shows the QR code first',
    })
  })
})
