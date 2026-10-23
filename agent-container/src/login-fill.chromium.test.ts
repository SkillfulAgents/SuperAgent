// Real-Chromium tests for request_login's page side: locating fields by
// focus over our own CDP connection, the in-page checks, and the write.
// Playwright stands in for agent-browser (it focuses the ref's element and
// reports its frame-local box) and drives the page; the module under test
// connects to the page on its own, as it does beside agent-browser in the
// container. Site isolation is forced on, so a cross-site login frame is out
// of process. Skipped when no Chromium is installed.
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core'
import { CdpConnection, callOnElement, locateFocusedElement } from './login-cdp'
import {
  awaitPageActivity,
  clickSubmitInPage,
  fillLogin,
  heldStates,
  lastFieldHasFocus,
  PageWatch,
  prepareLogin,
  type LoginFillDeps,
  type LoginFieldRequest,
  type PreparedLogin,
  type WrittenField,
} from './login-fill'
import { LOGIN_FIELD_INPUT_TYPES, WRITE_FIELD_FUNCTION, type WriteFieldResult } from './login-form-script'

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

const LOGIN_FORM = `<form onsubmit="event.preventDefault()">
  <label for="u">Username</label><input id="u" type="text" autocomplete="username">
  <label for="p">Password</label><input id="p" type="password" autocomplete="current-password">
  <button type="submit">Log in</button>
</form>`

const PAGES: Record<string, string> = {
  '/login.html': `<!doctype html><title>Login</title>${LOGIN_FORM}`,
  // The sign-in form lives in a frame of another site.
  '/outer.html': `<!doctype html><title>Outer</title><h1>Shop</h1><iframe id="login" width="420" height="220"></iframe>
    <script>document.getElementById('login').src = location.protocol + '//localhost:' + location.port + '/login.html'</script>`,
  // React's input value tracking and a controlled re-render.
  '/react.html': `<!doctype html><title>Controlled</title>
    <label for="email">Email</label><input id="email" type="email">
    <label for="pw">Password</label><input id="pw" type="password">
    <div id="state"></div>
    <script>
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      const state = { email: '', pw: '' };
      for (const id of ['email', 'pw']) {
        const node = document.getElementById(id);
        let current = '';
        Object.defineProperty(node, 'value', { configurable: true, get() { return native.get.call(this) }, set(v) { current = '' + v; native.set.call(this, v) } });
        node.addEventListener('input', () => {
          const next = native.get.call(node);
          if (next !== current) { current = next; state[id] = next; }
          node.value = state[id];
          document.getElementById('state').textContent = state.email + '|' + state.pw.length;
        });
      }
    </script>`,
  '/otp.html': `<!doctype html><title>Code</title><div id="boxes">
    ${Array.from({ length: 6 }, (_, i) => `<input class="b" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join('')}
    </div><script>
      const boxes = [...document.querySelectorAll('.b')];
      boxes.forEach((box, i) => box.addEventListener('input', () => { box.value = box.value.replace(/\\D/g, '').slice(-1); if (box.value && boxes[i + 1]) boxes[i + 1].focus(); }));
    </script>`,
  // A code field that submits its form by itself on the last digit.
  '/autosubmit.html': `<!doctype html><title>Verify</title>
    <form id="f"><label for="c">Code</label><input id="c" inputmode="numeric" maxlength="6"><button>Verify</button></form>
    <div id="count">0</div>
    <script>
      const form = document.getElementById('f');
      form.addEventListener('submit', (e) => { e.preventDefault(); document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1); });
      document.getElementById('c').addEventListener('input', (e) => { if (e.target.value.length === 6) form.requestSubmit(); });
    </script>`,
  // The same, after a debounce longer than the watch for a password.
  '/debounce.html': `<!doctype html><title>Verify</title>
    <form id="f"><input id="c" inputmode="numeric" maxlength="6"><button>Verify</button></form>
    <script>
      const form = document.getElementById('f');
      form.addEventListener('submit', (e) => e.preventDefault());
      document.getElementById('c').addEventListener('input', (e) => { if (e.target.value.length === 6) setTimeout(() => form.requestSubmit(), 600); });
    </script>`,
  // A code verified by fetch on its last digit: no submit event at all.
  '/fetchverify.html': `<!doctype html><title>Verify</title>
    <input id="c" inputmode="numeric" maxlength="6"><button id="v">Verify</button>
    <script>
      document.getElementById('c').addEventListener('input', (e) => {
        if (e.target.value.length === 6) fetch('/verify?step=2', { method: 'POST', body: e.target.value });
      });
    </script>`,
  '/verify': 'ok',
  // A page whose bot defense posts telemetry as fields change: none of it carries the code.
  '/telemetry.html': `<!doctype html><title>Verify</title>
    <input id="c" inputmode="numeric" maxlength="6"><button id="v">Verify</button>
    <script>
      document.getElementById('c').addEventListener('input', () => {
        fetch('/telemetry', { method: 'POST', body: JSON.stringify({ t: Date.now(), moves: [3, 1, 4] }) });
      });
    </script>`,
  '/telemetry': 'ok',
  // A form inside a shadow root: its submit event never reaches the document.
  '/shadow.html': `<!doctype html><title>Verify</title><div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<form><input id="c" inputmode="numeric" maxlength="6"><button>Verify</button></form>';
      const form = root.querySelector('form');
      form.addEventListener('submit', (e) => e.preventDefault());
      root.getElementById('c').addEventListener('input', (e) => { if (e.target.value.length === 6) form.requestSubmit(); });
    </script>`,
  // Code boxes that apply each typed digit a moment later (a framework's effect).
  '/latebox.html': `<!doctype html><title>Code</title><div>
    ${Array.from({ length: 6 }, (_, i) => `<input class="b" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join('')}
    </div><script>
      for (const box of document.querySelectorAll('.b')) {
        box.addEventListener('input', () => { const typed = box.value; box.value = ''; setTimeout(() => { box.value = typed.slice(-1); }, 30); });
      }
    </script>`,
  // Yahoo's shape: the first box takes a pasted code and spreads it, one character per box.
  '/spread.html': `<!doctype html><title>Code</title><div>
    <input class="b" maxlength="6" inputmode="numeric" aria-label="Code 1">
    ${Array.from({ length: 5 }, (_, i) => `<input class="b" maxlength="6" inputmode="numeric" aria-label="Code ${i + 2}">`).join('')}
    </div><script>
      const boxes = [...document.querySelectorAll('.b')];
      boxes.forEach((box, i) => box.addEventListener('input', () => {
        const chars = box.value.replace(/\\D/g, '').split('');
        chars.forEach((char, j) => { if (boxes[i + j]) boxes[i + j].value = char; });
        (boxes[i + chars.length] || boxes[boxes.length - 1]).focus();
      }));
    </script>`,
  // A page that moves on to another document by itself on the last digit.
  '/navigates.html': `<!doctype html><title>Verify</title>
    <input id="c" inputmode="numeric" maxlength="6">
    <script>
      document.getElementById('c').addEventListener('input', (e) => { if (e.target.value.length === 6) setTimeout(() => { location.href = '/login.html?next=1'; }, 50); });
    </script>`,
  // An email step whose Continue button a banner covers; nextStep() swaps in
  // the password step, with a button of the same name, in the same document.
  '/covered.html': `<!doctype html><title>Sign in</title>
    <section id="step1"><label for="email">Email</label><input id="email" type="email" autocomplete="username">
      <span style="position:relative;display:inline-block"><button type="button" data-step="1">Continue</button>
      <span style="position:absolute;inset:0;background:rgba(0,0,0,.4)"></span></span></section>
    <div id="log"></div>
    <script>
      document.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (button) document.getElementById('log').textContent += 'step' + button.dataset.step + ';';
      });
      function nextStep(mode) {
        const first = document.getElementById('step1');
        if (mode === 'remove') first.remove(); else first.style.display = 'none';
        const second = document.createElement('section');
        second.innerHTML = '<label for="pw">Password</label><input id="pw" type="password"><button type="button" data-step="2">Continue</button>';
        document.body.prepend(second);
      }
    </script>`,
}

describe.skipIf(!CHROMIUM)('request_login in real Chromium', { timeout: 30_000 }, () => {
  let server: http.Server
  let port = 0
  let userDataDir = ''
  let devtools = ''
  let context: BrowserContext
  let page: Page
  const refs = new Map<string, Locator>()

  const deps: LoginFillDeps = {
    focusRef: async (ref) => {
      const locator = refs.get(ref)
      if (!locator) return `✗ Unknown ref: ${ref.slice(1)}`
      await locator.focus()
      return null
    },
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
    remeasureMs: 50,
  }

  const site = (host: string, pathname: string) => `http://${host}:${port}${pathname}`
  const loginFrame = (): Frame | undefined => page.frames().find((frame) => frame.url().includes('localhost'))
  const fields = (username: string, password: string): LoginFieldRequest[] => [
    { ref: username, kind: 'username', label: 'Username' },
    { ref: password, kind: 'password', label: 'Password' },
  ]

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' })
      res.end(body ?? 'not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-chromium-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROMIUM!,
      headless: true,
      args: ['--no-sandbox', '--site-per-process', '--remote-debugging-port=0'],
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

  it('keeps the values in React-style controlled inputs', async () => {
    await page.goto(site('127.0.0.1', '/react.html'))
    refs.clear()
    refs.set('@e1', page.locator('#email'))
    refs.set('@e2', page.locator('#pw'))
    const prepared = await prepareLogin(deps, [{ ref: '@e1', kind: 'username', label: 'Email' }, { ref: '@e2', kind: 'password', label: 'Password' }])
    expect(prepared).toMatchObject({ ok: true, origin: `http://127.0.0.1:${port}`, topOrigin: `http://127.0.0.1:${port}` })
    if (!prepared.ok) return
    const cdp = await deps.connect()
    try {
      const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['carol@example.com', 'react-pw-1'], 'fill-1')
      expect(outcomes.map((o) => o.status)).toEqual(['filled', 'filled'])
      await expect(heldStates(cdp, written)).resolves.toEqual([{ index: 0, state: 'held' }, { index: 1, state: 'held' }])
    } finally {
      cdp.close()
    }
    expect(await page.locator('#state').textContent()).toBe('carol@example.com|10')
  })

  it('locates and fills a login form in an out-of-process frame of another site', async () => {
    await page.goto(site('127.0.0.1', '/outer.html'))
    await expect.poll(() => loginFrame()?.url()).toContain('/login.html')
    const frame = loginFrame()!
    await frame.locator('#u').waitFor()
    refs.clear()
    refs.set('@e3', frame.locator('#u'))
    refs.set('@e4', frame.locator('#p'))

    // The walk reaches the field through the frame's own target.
    await refs.get('@e4')!.focus()
    const probe = await deps.connect()
    try {
      const located = await locateFocusedElement(probe)
      expect('missed' in located).toBe(false)
      if ('missed' in located) return
      expect(located.sessionId).toBeDefined()
      expect(located.description).toMatchObject({ tag: 'input', type: 'password', origin: `http://localhost:${port}` })
      expect(located.topOrigin).toBe(`http://127.0.0.1:${port}`)
    } finally {
      probe.close()
    }

    const prepared = await prepareLogin(deps, fields('@e3', '@e4'))
    expect(prepared).toMatchObject({ ok: true, origin: `http://localhost:${port}`, topOrigin: `http://127.0.0.1:${port}` })
    if (!prepared.ok) return
    const cdp = await deps.connect()
    try {
      const { outcomes } = await fillLogin(deps, cdp, prepared, ['bob', 'frame-pass-123'], 'fill-2')
      expect(outcomes.map((o) => o.status)).toEqual(['filled', 'filled'])
    } finally {
      cdp.close()
    }
    expect(await frame.locator('#u').inputValue()).toBe('bob')
    expect(await frame.locator('#p').inputValue()).toBe('frame-pass-123')
  })

  it('writes nothing once the login frame has moved to another site', async () => {
    await page.goto(site('127.0.0.1', '/outer.html'))
    await expect.poll(() => loginFrame()?.url()).toContain('/login.html')
    let frame = loginFrame()!
    await frame.locator('#u').waitFor()
    refs.clear()
    refs.set('@e5', frame.locator('#u'))
    refs.set('@e6', frame.locator('#p'))
    const prepared = await prepareLogin(deps, fields('@e5', '@e6'))
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    // Same form, now served by the page's own site: a ref resolved by role and
    // name would land in it.
    await page.evaluate((url) => { document.querySelector('iframe')!.src = url }, site('127.0.0.1', '/login.html'))
    await expect.poll(() => page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(`http://127.0.0.1:${port}/login`))).toBeTruthy()
    frame = page.frames().find((f) => f !== page.mainFrame())!
    await frame.locator('#u').waitFor()
    refs.set('@e5', frame.locator('#u'))
    refs.set('@e6', frame.locator('#p'))

    const cdp = await deps.connect()
    try {
      const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['victim', 'do-not-leak'], 'fill-3')
      expect(outcomes.every((o) => o.status === 'failed')).toBe(true)
      expect(outcomes[0].problem).toBe(`the frame holding the fields is now on http://127.0.0.1:${port}, not http://localhost:${port}`)
      expect(written).toEqual([])
    } finally {
      cdp.close()
    }
    expect(await frame.locator('#p').inputValue()).toBe('')
  })

  it('refuses in the page itself a write aimed at another origin', async () => {
    await page.goto(site('127.0.0.1', '/login.html'))
    await page.locator('#p').focus()
    const cdp = await deps.connect()
    try {
      const located = await locateFocusedElement(cdp)
      if ('missed' in located) throw new Error('nothing focused')
      const result = await callOnElement<WriteFieldResult>(cdp, located, WRITE_FIELD_FUNCTION, [
        'leak-me', 'http://evil.example', 'password', LOGIN_FIELD_INPUT_TYPES.password, located.description.box, true, 'fill-4',
      ])
      expect(result).toEqual({ ok: false, reason: 'origin_changed', origin: `http://127.0.0.1:${port}` })
    } finally {
      cdp.close()
    }
    expect(await page.locator('#p').inputValue()).toBe('')
  })

  it('types a code across split boxes that move focus themselves', async () => {
    await page.goto(site('127.0.0.1', '/otp.html'))
    refs.clear()
    refs.set('@e7', page.locator('.b').first())
    const prepared = await prepareLogin(deps, [{ ref: '@e7', kind: 'otp', label: 'Code' }])
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const cdp = await deps.connect()
    try {
      const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['135 792'], 'fill-5')
      expect(outcomes[0]).toMatchObject({ status: 'filled', boxes: 6 })
      await expect(heldStates(cdp, written)).resolves.toEqual([{ index: 0, state: 'held' }])
      // Focus ended in the last box, which is part of the field: Enter lands in it.
      await expect(lastFieldHasFocus(cdp, written, `http://127.0.0.1:${port}`)).resolves.toBe(true)
      // The page locks the boxes while it verifies: read as locked, not as another code.
      await page.locator('.b').evaluateAll((boxes) => boxes.forEach((b) => { (b as HTMLInputElement).disabled = true }))
      await expect(heldStates(cdp, written)).resolves.toEqual([{ index: 0, state: 'locked' }])
    } finally {
      cdp.close()
    }
    const code = await page.locator('.b').evaluateAll((boxes) => boxes.map((b) => (b as HTMLInputElement).value).join(''))
    expect(code).toBe('135792')
    // On screen the digits are masked: a screenshot shows no code.
    const masks = await page.locator('.b').evaluateAll((boxes) => boxes.map((b) => getComputedStyle(b).getPropertyValue('-webkit-text-security')))
    expect(masks).toEqual(Array(6).fill('disc'))
  })

  it('reads back code boxes that took the digits a moment after the write as holding the code', async () => {
    await page.goto(site('127.0.0.1', '/latebox.html'))
    refs.clear()
    refs.set('@e7', page.locator('.b').first())
    const prepared = await prepareLogin(deps, [{ ref: '@e7', kind: 'otp', label: 'Code' }])
    if (!prepared.ok) throw new Error('not prepared')
    const cdp = await deps.connect()
    try {
      const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['135792'], 'fill-late')
      // Right after the write the boxes are still empty.
      expect(outcomes[0]).toMatchObject({ status: 'changed', boxes: 6 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await expect(heldStates(cdp, written)).resolves.toEqual([{ index: 0, state: 'held' }])
    } finally {
      cdp.close()
    }
  })

  it('fills a code into a box that spreads it over the boxes after it, and reads it back there', async () => {
    await page.goto(site('127.0.0.1', '/spread.html'))
    refs.clear()
    refs.set('@e7', page.locator('.b').first())
    const prepared = await prepareLogin(deps, [{ ref: '@e7', kind: 'otp', label: 'Code 1' }])
    if (!prepared.ok) throw new Error('not prepared')
    const cdp = await deps.connect()
    try {
      const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['482 913'], 'fill-spread')
      expect(outcomes[0]).toMatchObject({ status: 'filled', boxes: 6 })
      await expect(heldStates(cdp, written)).resolves.toEqual([{ index: 0, state: 'held' }])
      await expect(lastFieldHasFocus(cdp, written, `http://127.0.0.1:${port}`)).resolves.toBe(true)
    } finally {
      cdp.close()
    }
    const boxes = await page.locator('.b').evaluateAll((nodes) => nodes.map((node) => [(node as HTMLInputElement).value, getComputedStyle(node).getPropertyValue('-webkit-text-security')]))
    expect(boxes).toEqual(['4', '8', '2', '9', '1', '3'].map((digit) => [digit, 'disc']))
  })

  /** Prepare a one-code page, fill it under a watch, and return what the page did within `waitMs`. */
  async function fillCodeAndWatch(pathname: string, locate: () => Locator, waitMs: number) {
    await page.goto(site('127.0.0.1', pathname))
    refs.clear()
    refs.set('@e8', locate())
    const prepared = await prepareLogin(deps, [{ ref: '@e8', kind: 'otp', label: 'Code' }])
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('not prepared')
    const cdp = await deps.connect()
    try {
      const watch = await PageWatch.start(cdp)
      const fillId = `fill-${pathname}`
      const { written } = await fillLogin(deps, cdp, prepared as Pick<PreparedLogin, 'origin' | 'fields'>, ['482913'], fillId, (_field, element) => watch.cover(element.sessionId))
      const refOf = (_field: WrittenField) => '@e8'
      const activity = await awaitPageActivity(cdp, written, fillId, watch, refOf, waitMs)
      watch.close()
      return activity
    } finally {
      cdp.close()
    }
  }

  it('sees a form the page submitted by itself, so it is not submitted twice', async () => {
    await expect(fillCodeAndWatch('/autosubmit.html', () => page.locator('#c'), 1_000)).resolves.toEqual({ kind: 'submit' })
    expect(await page.locator('#count').textContent()).toBe('1')
  })

  it('sees a submit the page held back for a debounce, within the wait after a code', async () => {
    await expect(fillCodeAndWatch('/debounce.html', () => page.locator('#c'), 1_000)).resolves.toEqual({ kind: 'submit' })
  })

  it('sees a code the page verifies by fetch, with no submit event', async () => {
    await expect(fillCodeAndWatch('/fetchverify.html', () => page.locator('#c'), 1_000)).resolves.toEqual({
      kind: 'request', method: 'POST', url: site('127.0.0.1', '/verify'),
    })
  })

  it('takes telemetry posted as the code goes in for nothing, so the submit goes ahead', async () => {
    await expect(fillCodeAndWatch('/telemetry.html', () => page.locator('#c'), 1_000)).resolves.toBeNull()
  })

  it('sees a form in a shadow root submit itself', async () => {
    await expect(fillCodeAndWatch('/shadow.html', () => page.locator('#host').locator('#c'), 1_000)).resolves.toEqual({ kind: 'submit' })
  })

  it('sees the page move on to another document by itself', async () => {
    const activity = await fillCodeAndWatch('/navigates.html', () => page.locator('#c'), 1_000)
    expect(activity).toEqual({ kind: 'navigation', url: site('127.0.0.1', '/login.html?next=1') })
  })

  it('sees nothing when the page waits for a click, so the submit goes ahead', async () => {
    await page.goto(site('127.0.0.1', '/login.html'))
    refs.clear()
    refs.set('@e1', page.locator('#u'))
    refs.set('@e2', page.locator('#p'))
    const prepared = await prepareLogin(deps, fields('@e1', '@e2'))
    if (!prepared.ok) throw new Error('not prepared')
    const cdp = await deps.connect()
    try {
      const watch = await PageWatch.start(cdp)
      const { written } = await fillLogin(deps, cdp, prepared, ['dave', 'click-me-pw'], 'fill-quiet', (_field, element) => watch.cover(element.sessionId))
      await expect(awaitPageActivity(cdp, written, 'fill-quiet', watch, () => '@e2', 400)).resolves.toBeNull()
      watch.close()
    } finally {
      cdp.close()
    }
    // A password field masks itself; the write restyles neither field.
    expect(await page.locator('#u, #p').evaluateAll((els) => els.map((el) => (el as HTMLElement).style.cssText))).toEqual(['', ''])
  })

  it('clicks a covered button from the page only while the step it filled is still there', async () => {
    // The submit ref resolves by role and name, as a stale agent-browser ref does.
    const run = async (moveOn: 'stay' | 'remove' | 'hide' | 'navigate') => {
      await page.goto(site('127.0.0.1', '/covered.html'))
      refs.clear()
      refs.set('@e1', page.locator('#email'))
      refs.set('@e9', page.getByRole('button', { name: 'Continue' }))
      const prepared = await prepareLogin(deps, [{ ref: '@e1', kind: 'username', label: 'Email' }])
      if (!prepared.ok) throw new Error('not prepared')
      const cdp = await deps.connect()
      try {
        const { written } = await fillLogin(deps, cdp, prepared, ['erin@example.com'], `fill-covered-${moveOn}`)
        // The page moves on by itself while the CLI's click is refused.
        if (moveOn === 'navigate') await page.goto(site('127.0.0.1', '/covered.html?next=1'))
        else if (moveOn !== 'stay') await page.evaluate((mode) => (window as unknown as { nextStep(mode: string): void }).nextStep(mode), moveOn)
        const clicked = await clickSubmitInPage(deps, cdp, '@e9', prepared.origin, written)
        return { clicked, log: await page.locator('#log').textContent() }
      } finally {
        cdp.close()
      }
    }
    await expect(run('stay')).resolves.toEqual({ clicked: true, log: 'step1;' })
    await expect(run('remove')).resolves.toEqual({ clicked: false, log: '' })
    await expect(run('hide')).resolves.toEqual({ clicked: false, log: '' })
    await expect(run('navigate')).resolves.toEqual({ clicked: false, log: '' })
  })
})
