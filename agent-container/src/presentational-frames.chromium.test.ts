// Real-Chromium check of what presentational-frames.ts relies on: Chrome
// reports a frame marked role="none"/"presentation" as IframePresentational
// (which agent-browser neither refs nor reads into), the observer counts such
// frames, and once the clear script drops the role each is a plain Iframe.
// Site isolation is forced on, so the cross-site frame is out of process.
// Skipped when no Chromium is installed.
import * as fs from 'fs'
import * as http from 'http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { observerScript, parseObservation } from './page-observer'
import { CLEAR_PRESENTATIONAL_ROLE_SCRIPT } from './presentational-frames'

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

const PAGES: Record<string, string> = {
  // Apple's sign-in frame is <iframe role="none" title="Sign In to your Apple Account">.
  '/page.html': `<!doctype html><title>Sign in</title>
    <iframe role="none" title="Same-site sign in" srcdoc="<input aria-label='Email'>"></iframe>
    <iframe id="cross" role="presentation" title="Cross-site sign in"></iframe>
    <iframe title="Plain frame" srcdoc="<p>Plain</p>"></iframe>
    <script>document.getElementById('cross').src = location.protocol + '//localhost:' + location.port + '/form.html'</script>`,
  '/form.html': '<!doctype html><title>Form</title><input aria-label="Email">',
}

describe.skipIf(!CHROMIUM)('presentational frames in real Chromium', { timeout: 30_000 }, () => {
  let server: http.Server
  let port = 0
  let browser: Browser
  let page: Page

  /** Each frame's accessibility role, by its name, as the page's tree reports it. */
  const frameRoles = async (): Promise<Record<string, string>> => {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> }
      const roles: Record<string, string> = {}
      for (const node of nodes) {
        const role = String(node.role?.value ?? '')
        if (role.startsWith('Iframe')) roles[String(node.name?.value ?? '')] = role
      }
      return roles
    } finally {
      await cdp.detach().catch(() => {})
    }
  }
  const observe = async () => parseObservation(await page.evaluate(observerScript()) as string)

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' })
      res.end(body ?? 'not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    browser = await chromium.launch({ executablePath: CHROMIUM!, headless: true, args: ['--no-sandbox', '--site-per-process'] })
    page = await browser.newPage()
  }, 60_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  })

  it('is IframePresentational until the role is dropped, then a plain Iframe', async () => {
    await page.goto(`http://127.0.0.1:${port}/page.html`)
    await expect.poll(frameRoles).toEqual({ 'Same-site sign in': 'IframePresentational', 'Cross-site sign in': 'IframePresentational', 'Plain frame': 'Iframe' })
    expect((await observe())?.presentationalFrames).toBe(2)

    expect(await page.evaluate(CLEAR_PRESENTATIONAL_ROLE_SCRIPT)).toBe(2)
    await expect.poll(frameRoles).toEqual({ 'Same-site sign in': 'Iframe', 'Cross-site sign in': 'Iframe', 'Plain frame': 'Iframe' })
    expect((await observe())?.presentationalFrames).toBe(0)
    // The frames themselves are untouched: the cross-site one still holds its form.
    expect(await page.frames().find((frame) => frame.url().includes('localhost'))?.locator('input').getAttribute('aria-label')).toBe('Email')
  })
})
