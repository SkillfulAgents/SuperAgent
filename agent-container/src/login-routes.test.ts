import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inputManager } from './input-manager'
import { forgetInjectedSecrets, redactInjectedSecrets, REDACTED } from './injected-secrets'
import { closePreparedLogins, forgetAllPreparedLogins, getPreparedLogin, putPreparedLogin } from './login-requests'
import type { LoginFillDeps, PageActivity, PreparedLogin, WrittenField } from './login-fill'
import type { LoginFillReport } from './login-schema'

vi.mock('./login-fill', () => ({
  prepareLogin: vi.fn(),
  preparePage: vi.fn(),
  fillLogin: vi.fn(),
  heldStates: vi.fn(),
  awaitPageActivity: vi.fn(),
  pageActivityNow: vi.fn(),
  clickSubmitInPage: vi.fn(),
  lastFieldHasFocus: vi.fn(),
  PageWatch: { start: vi.fn() },
}))
const fill = await import('./login-fill')
const { clickSubmit, registerLoginRoutes } = await import('./login-routes')

const cdp = { close: vi.fn() }
const watch = { cover: vi.fn(async () => {}), close: vi.fn() }
const fillDeps = { connect: vi.fn(async () => cdp), boxOfRef: vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 })), focusRef: vi.fn() } as unknown as LoginFillDeps
const deps = {
  hostAuthEnabled: vi.fn(() => true),
  validateSession: vi.fn((): string | null => null),
  browserActive: vi.fn(() => true),
  fillDeps: () => fillDeps,
  submit: vi.fn(),
  observeUrl: vi.fn(async () => ({ url: 'https://github.com/sessions/two-factor', navigated: true })),
  notifyBrowserAction: vi.fn(),
  contextWaitMs: 50,
  pendingWaitMs: 300,
  pageSubmitWaitMs: 4,
  codeSubmitWaitMs: 7,
}

const PREPARED: PreparedLogin = {
  toolUseId: 'tu-1',
  sessionId: 's-1',
  origin: 'https://github.com',
  url: 'https://github.com/login',
  topOrigin: 'https://github.com',
  fields: [
    { ref: '@e3', kind: 'username', label: 'Email', inputType: 'email', inputMode: '', autocomplete: 'username', maxLength: -1 },
    { ref: '@e6', kind: 'password', label: 'Password', inputType: 'password', inputMode: '', autocomplete: 'current-password', maxLength: -1 },
  ],
  held: [],
  providers: [],
  submitRef: '@e7',
  preparedAt: 1,
}

const written = (index: number, kind: 'username' | 'password' | 'otp', kept = true): WrittenField =>
  ({ index, kind, element: { sessionId: undefined, objectId: `o${index}` } as WrittenField['element'], value: 'v', kept, startedAt: 1 })

let app: Hono
const parked = new Map<string, Promise<string>>()

function park(toolUseId: string, inputType = 'login') {
  const answer = inputManager.createPendingWithType<string>(toolUseId, inputType, {})
  answer.catch(() => {})
  parked.set(toolUseId, answer)
}

async function post(path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

const fillBody = (over: Record<string, unknown> = {}) => ({
  sessionId: 's-1', toolUseId: 'tu-1', expectedOrigin: 'https://github.com', values: ['octocat@example.com', 'hunter2-pass'], ...over,
})

async function report(toolUseId = 'tu-1'): Promise<LoginFillReport> {
  return JSON.parse(await parked.get(toolUseId)!)
}

beforeEach(() => {
  vi.clearAllMocks()
  app = new Hono()
  registerLoginRoutes(app, deps)
  vi.mocked(fill.fillLogin).mockResolvedValue({
    outcomes: [
      { ref: '@e3', kind: 'username', label: 'Email', status: 'filled' },
      { ref: '@e6', kind: 'password', label: 'Password', status: 'filled' },
    ],
    written: [written(0, 'username'), written(1, 'password')],
    pageValues: [],
  })
  vi.mocked(fill.PageWatch.start).mockResolvedValue(watch as unknown as Awaited<ReturnType<typeof fill.PageWatch.start>>)
  vi.mocked(fill.awaitPageActivity).mockResolvedValue(null)
  vi.mocked(fill.pageActivityNow).mockResolvedValue(null)
  vi.mocked(fill.heldStates).mockResolvedValue([{ index: 0, state: 'held' }, { index: 1, state: 'held' }])
  deps.submit.mockResolvedValue({ ok: true, submitted: { via: 'click', ref: '@e7' }, observation: { settleMs: 300 } })
})

afterEach(() => {
  // Only what is still open: a reject for an answered id would be buffered
  // as an early answer and greet the next test's request under that id.
  for (const id of parked.keys()) if (inputManager.hasPending(id)) inputManager.reject(id, 'test over')
  parked.clear()
  forgetAllPreparedLogins()
  forgetInjectedSecrets()
})

describe('fields of a later step, and pages without fields', () => {
  it('passes a field without a ref through as held, and locates the rest', async () => {
    vi.mocked(fill.prepareLogin).mockResolvedValue({ ok: true, origin: 'https://github.com', url: 'https://github.com/login', topOrigin: 'https://github.com', fields: [PREPARED.fields[0]] })
    const res = await post('/browser/login/prepare', {
      sessionId: 's-1', toolUseId: 'tu-1', submitRef: '@e7',
      fields: [{ ref: 'e3', kind: 'username', label: 'Email' }, { kind: 'password', label: 'Password' }],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ held: [{ kind: 'password', label: 'Password' }] })
    expect(vi.mocked(fill.prepareLogin).mock.calls[0][1]).toEqual([{ ref: '@e3', kind: 'username', label: 'Email' }])
    const context = await (await app.request('/browser/login/context?toolUseId=tu-1')).json()
    expect(context.fields).toHaveLength(1)
    expect(context.held).toEqual([{ kind: 'password', label: 'Password' }])
  })

  it('refuses a username or code without a ref, fields without refs alone, and a submit with no field', async () => {
    const attempts = [
      [{ ref: 'e3', kind: 'username', label: 'Email' }, { kind: 'otp', label: 'Code' }],
      [{ kind: 'password', label: 'Password' }],
    ]
    for (const [index, fields] of attempts.entries()) {
      const res = await post('/browser/login/prepare', { sessionId: 's-1', toolUseId: `tu-held-${index}`, submitRef: null, fields })
      expect(res.status).toBe(422)
    }
    const submitOnly = await post('/browser/login/prepare', { sessionId: 's-1', toolUseId: 'tu-submit', submitRef: '@e7', fields: [] })
    expect(submitOnly.status).toBe(422)
    expect(fill.prepareLogin).not.toHaveBeenCalled()
  })

  it('takes the page\'s main frame as the site when no field is mapped', async () => {
    vi.mocked(fill.preparePage).mockResolvedValue({ ok: true, origin: 'https://medium.com', url: 'https://medium.com/m/signin', topOrigin: 'https://medium.com', fields: [] })
    const res = await post('/browser/login/prepare', { sessionId: 's-1', toolUseId: 'tu-1', submitRef: null, fields: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ origin: 'https://medium.com', fields: [], held: [] })
    expect(fill.prepareLogin).not.toHaveBeenCalled()
  })

  it("passes the page's sign-in providers through to the form, once each, and only known ones", async () => {
    vi.mocked(fill.preparePage).mockResolvedValue({ ok: true, origin: 'https://medium.com', url: 'https://medium.com/m/signin', topOrigin: 'https://medium.com', fields: [] })
    const body = { sessionId: 's-1', toolUseId: 'tu-1', submitRef: null, fields: [] }
    expect((await post('/browser/login/prepare', { ...body, toolUseId: 'tu-0', providers: ['google', 'okta'] })).status).toBe(400)
    expect((await post('/browser/login/prepare', { ...body, providers: ['google', 'apple', 'google'] })).status).toBe(200)
    const context = await (await app.request('/browser/login/context?toolUseId=tu-1')).json()
    expect(context.providers).toEqual(['google', 'apple'])
  })

  it('waits for the tool to open its request before a fill from the vault', async () => {
    putPreparedLogin(PREPARED)
    const filling = post('/browser/login/fill', fillBody())
    await new Promise((resolve) => setTimeout(resolve, 60))
    park('tu-1')
    expect((await filling).status).toBe(200)
  })

  it('refuses a fill whose request never opened', async () => {
    putPreparedLogin(PREPARED)
    expect((await post('/browser/login/fill', fillBody())).status).toBe(409)
    expect(fill.fillLogin).not.toHaveBeenCalled()
  })

  it('carries the account the values came from into the agent\'s report', async () => {
    putPreparedLogin(PREPARED)
    park('tu-1')
    const account = { username: 'octocat', site: 'github.com', source: 'vault', saved: false, held: [] }
    expect((await post('/browser/login/fill', fillBody({ account }))).status).toBe(200)
    expect((await report()).account).toEqual(account)
  })
})

describe('POST /browser/login/prepare', () => {
  const body = { sessionId: 's-1', toolUseId: 'tu-1', fields: [{ ref: 'e3', kind: 'username', label: 'Email' }], submitRef: '@e7' }

  it('locates the fields and keeps what the host will read', async () => {
    vi.mocked(fill.prepareLogin).mockResolvedValue({ ok: true, origin: 'https://github.com', url: 'https://github.com/login', topOrigin: 'https://github.com', fields: [PREPARED.fields[0]] })
    const res = await post('/browser/login/prepare', body)
    expect(res.status).toBe(200)
    expect(vi.mocked(fill.prepareLogin).mock.calls[0][1]).toEqual([{ ref: '@e3', kind: 'username', label: 'Email' }])
    expect(getPreparedLogin('tu-1')).toMatchObject({ origin: 'https://github.com', sessionId: 's-1', submitRef: '@e7' })
  })

  it('records why it could not, so the host stops waiting', async () => {
    vi.mocked(fill.prepareLogin).mockResolvedValue({ ok: false, problems: ['@e3 is not visible'] })
    expect((await post('/browser/login/prepare', body)).status).toBe(422)
    const context = await app.request('/browser/login/context?toolUseId=tu-1')
    expect(context.status).toBe(409)
    expect(await context.json()).toMatchObject({ problems: ['@e3 is not visible'] })
  })

  it('refuses a session that does not own the browser, and a submit ref mapped as a field', async () => {
    deps.validateSession.mockReturnValueOnce('Browser is owned by another session')
    expect((await post('/browser/login/prepare', body)).status).toBe(409)
    expect((await post('/browser/login/prepare', { ...body, toolUseId: 'tu-2', submitRef: '@e3' })).status).toBe(422)
    expect(fill.prepareLogin).not.toHaveBeenCalled()
  })

  it('prepares a request once: its fields cannot be remapped after the host was shown them', async () => {
    vi.mocked(fill.prepareLogin).mockResolvedValue({ ok: true, origin: 'https://github.com', url: 'https://github.com/login', topOrigin: 'https://github.com', fields: [PREPARED.fields[1]] })
    expect((await post('/browser/login/prepare', { ...body, fields: [{ ref: '@e6', kind: 'password', label: 'Password' }] })).status).toBe(200)
    const remap = await post('/browser/login/prepare', { ...body, fields: [{ ref: '@e6', kind: 'username', label: 'Password' }] })
    expect(remap.status).toBe(409)
    expect(fill.prepareLogin).toHaveBeenCalledTimes(1)
    expect(getPreparedLogin('tu-1')?.fields.map((field) => field.kind)).toEqual(['password'])
  })

  it('refuses a second prepare of the same request while the first is still locating', async () => {
    let release!: () => void
    vi.mocked(fill.prepareLogin).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, origin: 'https://github.com', url: 'https://github.com/login', topOrigin: 'https://github.com', fields: [PREPARED.fields[0]] })
    }))
    const first = post('/browser/login/prepare', body)
    await vi.waitFor(() => expect(fill.prepareLogin).toHaveBeenCalled())
    expect((await post('/browser/login/prepare', body)).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
  })
})

describe('GET /browser/login/context', () => {
  it('requires host authentication', async () => {
    deps.hostAuthEnabled.mockReturnValueOnce(false)
    expect((await app.request('/browser/login/context?toolUseId=tu-1')).status).toBe(503)
  })

  it('waits for the fields, then serves kinds, labels and hints — never a value', async () => {
    const pending = app.request('/browser/login/context?toolUseId=tu-1')
    putPreparedLogin(PREPARED)
    const res = await pending
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      origin: 'https://github.com',
      url: 'https://github.com/login',
      topOrigin: 'https://github.com',
      submit: true,
      fields: PREPARED.fields.map(({ ref: _ref, ...rest }) => rest),
      held: [],
      providers: [],
    })
  })

  it('answers 404 while nothing is known under the id, for the host to try again', async () => {
    expect((await app.request('/browser/login/context?toolUseId=unknown')).status).toBe(404)
  })
})

describe('POST /browser/login/fill', () => {
  beforeEach(() => {
    putPreparedLogin(PREPARED)
    park('tu-1')
  })

  it('requires host authentication', async () => {
    deps.hostAuthEnabled.mockReturnValueOnce(false)
    expect((await post('/browser/login/fill', fillBody())).status).toBe(503)
    expect(fillDeps.connect).not.toHaveBeenCalled()
  })

  it('says the browser closed, for a request located before it did, and leaves the request open', async () => {
    closePreparedLogins()
    const res = await post('/browser/login/fill', fillBody())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'The browser that showed this sign-in form was closed', reason: 'browser_closed' })
    expect(fillDeps.connect).not.toHaveBeenCalled()
    expect(inputManager.hasPending('tu-1')).toBe(true)
    // The form is still the user's to read.
    expect((await app.request('/browser/login/context?toolUseId=tu-1')).status).toBe(200)

    // No browser at all says the same.
    putPreparedLogin({ ...PREPARED, toolUseId: 'tu-2' })
    park('tu-2')
    deps.browserActive.mockReturnValueOnce(false)
    expect(await (await post('/browser/login/fill', fillBody({ toolUseId: 'tu-2' }))).json()).toMatchObject({ reason: 'browser_closed' })
  })

  it('refuses values for another origin than the browser located, before touching the page', async () => {
    const res = await post('/browser/login/fill', fillBody({ expectedOrigin: 'https://evil.example' }))
    expect(res.status).toBe(409)
    expect(fillDeps.connect).not.toHaveBeenCalled()
    expect(inputManager.hasPending('tu-1')).toBe(true)
  })

  it('refuses a request that is not an open sign-in', async () => {
    putPreparedLogin({ ...PREPARED, toolUseId: 'tu-other' })
    park('tu-other', 'browser_input')
    expect((await post('/browser/login/fill', fillBody({ toolUseId: 'tu-other' }))).status).toBe(409)
    expect((await post('/browser/login/fill', fillBody({ toolUseId: 'tu-gone' }))).status).toBe(409)
    expect(fillDeps.connect).not.toHaveBeenCalled()
  })

  it('refuses a malformed body without echoing it', async () => {
    const res = await post('/browser/login/fill', { ...fillBody(), extra: 'x' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('hunter2')
    expect((await post('/browser/login/fill', fillBody({ values: ['hunter2-pass'] }))).status).toBe(400)
    expect((await post('/browser/login/fill', fillBody({ values: ['', ''] }))).status).toBe(400)
  })

  it('remembers secrets for redaction before the page is first read — and never the identifier', async () => {
    let atFirstRead: [string, string] | null = null
    vi.mocked(fill.fillLogin).mockImplementationOnce(async () => {
      atFirstRead = [redactInjectedSecrets('hunter2-pass'), redactInjectedSecrets('octocat@example.com')]
      return { outcomes: [], written: [], pageValues: ['HUNTER2-PASS'] }
    })
    await post('/browser/login/fill', fillBody())
    expect(atFirstRead).toEqual([REDACTED, 'octocat@example.com'])
    // A secret the page rewrote is remembered too.
    expect(redactInjectedSecrets('HUNTER2-PASS')).toBe(REDACTED)
  })

  it('remembers a code as it is written (without the spaces the user typed), and watches its frame first', async () => {
    const code = { ref: '@e9', kind: 'otp' as const, label: 'Code', inputType: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7 }
    putPreparedLogin({ ...PREPARED, toolUseId: 'tu-code', fields: [code] })
    park('tu-code')
    vi.mocked(fill.fillLogin).mockImplementationOnce(async (_deps, _cdp, _prepared, _values, _fillId, beforeWrite) => {
      await beforeWrite!(code, { sessionId: 'S-frame' } as WrittenField['element'], '482913')
      return { outcomes: [], written: [], pageValues: [] }
    })
    await post('/browser/login/fill', fillBody({ toolUseId: 'tu-code', values: ['482 913'] }))
    expect(redactInjectedSecrets('code=482913')).toBe(`code=${REDACTED}`)
    expect(redactInjectedSecrets('482 913')).toBe(REDACTED)
    expect(watch.cover).toHaveBeenCalledWith('S-frame')
  })

  it('fills, submits, and answers the agent with a report that holds no value', async () => {
    const res = await post('/browser/login/fill', fillBody())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, filled: 2, failed: 0, outcomes: ['filled', 'filled'], submitted: true, problems: [] })
    const answer = await parked.get('tu-1')!
    expect(answer).not.toContain('hunter2')
    expect(JSON.parse(answer)).toMatchObject({ type: 'filled', origin: 'https://github.com', submitted: { via: 'click', ref: '@e7' } })
    expect(getPreparedLogin('tu-1')).toBeNull()
    expect(cdp.close).toHaveBeenCalled()
    expect(watch.close).toHaveBeenCalled()
    expect(deps.notifyBrowserAction).toHaveBeenCalled()
    // A password last: the short wait for the page to submit by itself.
    expect(vi.mocked(fill.awaitPageActivity).mock.calls[0][5]).toBe(4)
  })

  it('watches longer for the page to submit by itself after a code', async () => {
    vi.mocked(fill.fillLogin).mockResolvedValueOnce({
      outcomes: [{ ref: '@e6', kind: 'otp', label: 'Code', status: 'filled' }],
      written: [written(1, 'otp')],
      pageValues: [],
    })
    await post('/browser/login/fill', fillBody())
    expect(vi.mocked(fill.awaitPageActivity).mock.calls[0][5]).toBe(7)
  })

  it('does not submit after a field failed', async () => {
    vi.mocked(fill.fillLogin).mockResolvedValueOnce({
      outcomes: [
        { ref: '@e3', kind: 'username', label: 'Email', status: 'filled' },
        { ref: '@e6', kind: 'password', label: 'Password', status: 'failed', problem: '@e6 is not visible' },
      ],
      written: [written(0, 'username')],
      pageValues: [],
    })
    const res = await post('/browser/login/fill', fillBody())
    expect(await res.json()).toMatchObject({ submitted: false, failed: 1, problems: ['Password: @e6 is not visible'] })
    expect(deps.submit).not.toHaveBeenCalled()
    expect((await report()).submitted).toBeNull()
  })

  it('presses nothing after a write that returned no answer, and tells the host it may have gone in', async () => {
    vi.mocked(fill.fillLogin).mockResolvedValueOnce({
      outcomes: [
        { ref: '@e3', kind: 'username', label: 'Email', status: 'filled' },
        { ref: '@e6', kind: 'password', label: 'Password', status: 'unconfirmed', problem: 'the write into @e6 was sent and returned no answer (timed out)' },
      ],
      written: [written(0, 'username')],
      pageValues: [],
    })
    const res = await post('/browser/login/fill', fillBody())
    expect(await res.json()).toMatchObject({ submitted: false, failed: 1, outcomes: ['filled', 'unconfirmed'] })
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('does not submit a password the page rewrote as it was written and still holds rewritten', async () => {
    vi.mocked(fill.fillLogin).mockResolvedValueOnce({
      outcomes: [
        { ref: '@e3', kind: 'username', label: 'Email', status: 'filled' },
        { ref: '@e6', kind: 'password', label: 'Password', status: 'changed' },
      ],
      written: [written(0, 'username'), written(1, 'password', false)],
      pageValues: [],
    })
    vi.mocked(fill.heldStates).mockResolvedValueOnce([{ index: 0, state: 'held' }, { index: 1, state: 'differs' }])
    const res = await post('/browser/login/fill', fillBody())
    expect(deps.submit).not.toHaveBeenCalled()
    expect(await report()).toMatchObject({ changedSecrets: ['@e6'], lost: [], submitted: null })
    expect((await res.json()).problems).toEqual(['Password: the field held a different value than you entered, so nothing was clicked or pressed'])
  })

  it('submits a code that read differently right after the write but holds it once the page settled', async () => {
    const code = { ref: '@e6', kind: 'otp' as const, label: 'Code' }
    vi.mocked(fill.fillLogin).mockResolvedValueOnce({
      outcomes: [{ ref: '@e3', kind: 'username', label: 'Email', status: 'filled' }, { ...code, status: 'changed', boxes: 6 }],
      written: [written(0, 'username'), written(1, 'otp', false)],
      pageValues: ['48291'],
    })
    vi.mocked(fill.heldStates).mockResolvedValueOnce([{ index: 0, state: 'held' }, { index: 1, state: 'held' }])
    await post('/browser/login/fill', fillBody())
    expect(deps.submit).toHaveBeenCalled()
    const answer = await report()
    expect(answer).toMatchObject({ submitted: { via: 'click', ref: '@e7' }, lost: [] })
    expect(answer.changedSecrets).toBeUndefined()
    expect(answer.outcomes[1].status).toBe('filled')
  })

  it('does not submit when a field lost its value, left its document, or could not be read back', async () => {
    vi.mocked(fill.heldStates).mockResolvedValueOnce([{ index: 0, state: 'unreadable', error: 'timed out' }, { index: 1, state: 'detached' }])
    const res = await post('/browser/login/fill', fillBody())
    expect(deps.submit).not.toHaveBeenCalled()
    expect((await report()).lost).toEqual([{ ref: '@e3', state: 'unreadable', error: 'timed out' }, { ref: '@e6', state: 'detached' }])
    expect((await res.json()).problems).toEqual([
      'Email: the field could not be read back, so nothing was clicked or pressed',
      'Password: the field was no longer in the page, so nothing was clicked or pressed',
    ])
  })

  it('does not submit a form whose fields the page locked after the write', async () => {
    vi.mocked(fill.heldStates).mockResolvedValueOnce([{ index: 0, state: 'held' }, { index: 1, state: 'locked' }])
    await post('/browser/login/fill', fillBody())
    expect(deps.submit).not.toHaveBeenCalled()
    expect(await report()).toMatchObject({ submitted: null, lost: [], pageActivity: { kind: 'locked', ref: '@e6' } })
  })

  it('does not submit again a form the page submitted itself, and says where it went', async () => {
    vi.mocked(fill.awaitPageActivity).mockResolvedValueOnce({ kind: 'submit' })
    await post('/browser/login/fill', fillBody())
    expect(deps.submit).not.toHaveBeenCalled()
    expect(await report()).toMatchObject({ submitted: { via: 'page' }, observation: { digest: { url: 'https://github.com/sessions/two-factor' } } })
  })

  it('does not submit after the page moved on by itself: a navigation, a request after a code, the document gone', async () => {
    for (const activity of [
      { kind: 'navigation' as const, url: 'https://github.com/sessions/two-factor' },
      { kind: 'request' as const, method: 'POST', url: 'https://github.com/verify' },
      { kind: 'gone' as const },
    ]) {
      putPreparedLogin(PREPARED)
      park('tu-1')
      vi.mocked(fill.awaitPageActivity).mockResolvedValueOnce(activity)
      const res = await post('/browser/login/fill', fillBody())
      expect(await res.json()).toMatchObject({ submitted: false })
      expect(await report()).toMatchObject({ submitted: null, pageActivity: activity })
    }
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('clicks nothing when the page moved on right before the click', async () => {
    deps.submit.mockResolvedValueOnce({ ok: true, submitted: null, activity: { kind: 'navigation', url: 'https://github.com/next' }, observation: { settleMs: 300 } })
    const res = await post('/browser/login/fill', fillBody())
    expect(await res.json()).toMatchObject({ submitted: false, problems: [] })
    expect(await report()).toMatchObject({ submitted: null, pageActivity: { kind: 'navigation', url: 'https://github.com/next' }, observation: { settleMs: 300 } })
  })

  it('reports a submit that did not go through', async () => {
    deps.submit.mockResolvedValueOnce({ ok: false, error: "clicking @e7 failed: ✗ Element '@e7' is detached" })
    const res = await post('/browser/login/fill', fillBody())
    expect(await res.json()).toMatchObject({ submitted: false, problems: ["Clicking @e7 failed: ✗ Element '@e7' is detached"] })
    expect(await report()).toMatchObject({ submitted: null, submitError: "clicking @e7 failed: ✗ Element '@e7' is detached" })
  })

  it('hands the submit a plan bound to this request\'s origin and fill', async () => {
    vi.mocked(fill.clickSubmitInPage).mockResolvedValueOnce(true)
    vi.mocked(fill.lastFieldHasFocus).mockResolvedValueOnce(false)
    vi.mocked(fill.pageActivityNow).mockResolvedValueOnce({ kind: 'submit' })
    deps.submit.mockImplementationOnce(async (plan) => {
      expect(plan.submitRef).toBe('@e7')
      await expect(plan.stillCurrent()).resolves.toEqual({ kind: 'submit' })
      await expect(plan.clickInPage()).resolves.toBe(true)
      await expect(plan.enterLandsInField()).resolves.toBe(false)
      return { ok: true, submitted: { via: 'click-in-page', ref: '@e7', clickError: 'covered' }, observation: {} }
    })
    await post('/browser/login/fill', fillBody())
    const [, , clickRef, clickOrigin, clickWritten] = vi.mocked(fill.clickSubmitInPage).mock.calls[0]
    expect([clickRef, clickOrigin]).toEqual(['@e7', 'https://github.com'])
    // Bound to the fields this fill wrote, the same ones the activity checks read.
    expect(clickWritten).toBe(vi.mocked(fill.pageActivityNow).mock.calls[0][1])
    expect(vi.mocked(fill.lastFieldHasFocus).mock.calls[0][2]).toBe('https://github.com')
    const [, writtenFields, fillId, pageWatch] = vi.mocked(fill.pageActivityNow).mock.calls[0]
    expect(writtenFields).toHaveLength(2)
    expect(fillId).toBe(vi.mocked(fill.fillLogin).mock.calls[0][4])
    expect(pageWatch).toBe(watch)
  })

  it('refuses a second fill of the same request while one is running', async () => {
    let release!: () => void
    vi.mocked(fill.fillLogin).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ outcomes: [], written: [], pageValues: [] })
    }))
    const first = post('/browser/login/fill', fillBody())
    await vi.waitFor(() => expect(fill.fillLogin).toHaveBeenCalled())
    const second = await post('/browser/login/fill', fillBody())
    expect(second.status).toBe(409)
    release()
    expect((await first).status).toBe(200)
  })

  it('leaves the request open when the browser could not be reached, for the user to retry', async () => {
    vi.mocked(fillDeps.connect).mockRejectedValueOnce(new Error('No active browser page was found'))
    const res = await post('/browser/login/fill', fillBody())
    expect(res.status).toBe(500)
    expect(inputManager.hasPending('tu-1')).toBe(true)
    expect(getPreparedLogin('tu-1')).not.toBeNull()
    // Not stuck "in flight": a retry runs.
    expect((await post('/browser/login/fill', fillBody())).status).toBe(200)
  })
})

describe('clickSubmit', () => {
  const plan = () => ({ stillCurrent: vi.fn(async (): Promise<PageActivity | null> => null), clickInPage: vi.fn(async () => true) })
  const covered = { exitCode: 1, stdout: "✗ Element '@e7' is covered by <div#cookie-banner> at its click point" }

  it('clicks through the CLI, and nothing else when that worked', async () => {
    const steps = plan()
    await expect(clickSubmit(steps, '@e7', async () => ({ exitCode: 0, stdout: 'Clicked' }))).resolves.toEqual({ clicked: 'cli', result: { exitCode: 0, stdout: 'Clicked' } })
    expect(steps.stillCurrent).not.toHaveBeenCalled()
    expect(steps.clickInPage).not.toHaveBeenCalled()
  })

  it('tries the page only when a banner covered the button', async () => {
    const steps = plan()
    const failed = { exitCode: 1, stdout: "✗ Element '@e7' not found" }
    await expect(clickSubmit(steps, '@e7', async () => failed)).resolves.toEqual({ clicked: null, result: failed })
    expect(steps.clickInPage).not.toHaveBeenCalled()

    await expect(clickSubmit(steps, '@e7', async () => covered)).resolves.toEqual({ clicked: 'in-page', cliError: covered.stdout })
    steps.clickInPage.mockResolvedValueOnce(false)
    await expect(clickSubmit(steps, '@e7', async () => covered)).resolves.toEqual({ clicked: null, result: covered })
  })

  it('clicks nothing from the page once the page moved on during the CLI attempt', async () => {
    const steps = plan()
    // Current before the CLI's attempt; moved on by the time it gave up.
    steps.stillCurrent.mockResolvedValueOnce({ kind: 'navigation', url: 'https://github.com/sessions/two-factor' })
    await expect(clickSubmit(steps, '@e7', async () => covered)).resolves.toEqual({
      clicked: null,
      activity: { kind: 'navigation', url: 'https://github.com/sessions/two-factor' },
    })
    expect(steps.clickInPage).not.toHaveBeenCalled()
  })
})
