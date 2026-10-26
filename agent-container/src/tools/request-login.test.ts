import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inputManager } from '../input-manager'
import { resetBrowserState, setBrowserState } from '../browser-state'
import { forgetAllPreparedLogins } from '../login-requests'
import { forgetInjectedSecrets, rememberInjectedSecret } from '../injected-secrets'
import { createRequestLoginTool, formatLoginResolution } from './request-login'
import type { LoginFillReport } from '../login-schema'

const args = {
  message: 'Sign in to GitHub so the agent can update the repository settings.',
  fields: [
    { ref: '@e3', kind: 'username' as const, label: 'Username or email address' },
    { ref: '@e6', kind: 'password' as const, label: 'Password' },
  ],
  submit: '@e7',
}

const prepared = {
  origin: 'https://github.com',
  url: 'https://github.com/login',
  fields: [
    { ref: '@e3', kind: 'username', label: 'Username or email address', inputType: 'text', inputMode: '', autocomplete: 'username', maxLength: -1 },
    { ref: '@e6', kind: 'password', label: 'Password', inputType: 'password', inputMode: '', autocomplete: 'current-password', maxLength: -1 },
  ],
}

function handlerFor(sessionId: string | null = 'session-1') {
  return (createRequestLoginTool(() => sessionId) as any).handler as (input: typeof args) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

describe('request_login tool', () => {
  beforeEach(() => {
    resetBrowserState()
    setBrowserState({ active: true, sessionId: 'session-1', cdpUrl: null, location: 'container' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetBrowserState()
    forgetAllPreparedLogins()
    forgetInjectedSecrets()
    inputManager.consumeCurrentToolUseId()
  })

  it('refuses without an open browser, before locating anything', async () => {
    resetBrowserState()
    const fetchMock = respond(200, prepared)
    vi.stubGlobal('fetch', fetchMock)
    inputManager.setCurrentToolUseId('login-closed')
    const result = await handlerFor()(args)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/no browser is open/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(inputManager.hasPending('login-closed')).toBe(false)
  })

  it('reports the mapping problems and parks nothing when the fields cannot be used', async () => {
    vi.stubGlobal('fetch', respond(422, { error: 'The sign-in fields could not be used', problems: ['@e6 is <input type=email>; a password goes into a password input'] }))
    inputManager.setCurrentToolUseId('login-bad-map')
    const result = await handlerFor()(args)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('The sign-in form was not shown to the user. @e6 is <input type=email>; a password goes into a password input.')
    expect(inputManager.hasPending('login-bad-map')).toBe(false)
  })

  it('redacts an injected value from a problem that quotes the page or the CLI', async () => {
    rememberInjectedSecret('hunter2-pass')
    vi.stubGlobal('fetch', respond(500, { problems: ['the page could not be read: ✗ fill @e6 "hunter2-pass" failed'] }))
    inputManager.setCurrentToolUseId('login-quoted')
    const result = await handlerFor()(args)
    expect(result.content[0].text).not.toContain('hunter2-pass')
    expect(result.content[0].text).toContain('[redacted]')
  })

  it('refuses an empty reason before anything is located', () => {
    const tool = createRequestLoginTool(() => 'session-1') as unknown as { inputSchema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }
    expect(tool.inputSchema.message.safeParse('  ').success).toBe(false)
    expect(tool.inputSchema.message.safeParse('Sign in to GitHub.').success).toBe(true)
    expect(tool.inputSchema.providers.safeParse(['google', 'apple']).success).toBe(true)
    expect(tool.inputSchema.providers.safeParse(['passkey']).success).toBe(false)
  })

  it('locates the fields for its own session, parks on the user, and reports the fill', async () => {
    const fetchMock = respond(200, prepared)
    vi.stubGlobal('fetch', fetchMock)
    inputManager.setCurrentToolUseId('login-ok')
    const done = handlerFor('session-7')({ ...args, providers: ['google', 'apple'] } as typeof args)

    await vi.waitFor(() => expect(inputManager.hasPending('login-ok')).toBe(true))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/browser\/login\/prepare$/)
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: 'session-7', toolUseId: 'login-ok', fields: args.fields, submitRef: '@e7', providers: ['google', 'apple'] })
    const parked = inputManager.getAllPending().find((p) => p.toolUseId === 'login-ok')
    expect(parked).toMatchObject({ inputType: 'login', metadata: { origin: 'https://github.com', message: args.message } })

    const report: LoginFillReport = {
      type: 'filled',
      origin: 'https://github.com',
      outcomes: [
        { ref: '@e3', kind: 'username', label: 'Username or email address', status: 'filled' },
        { ref: '@e6', kind: 'password', label: 'Password', status: 'filled' },
      ],
      lost: [],
      submitted: { via: 'click', ref: '@e7' },
      observation: { settleMs: 400, digest: { url: 'https://github.com/session', navigated: true } },
    }
    inputManager.resolve('login-ok', JSON.stringify(report))
    const result = await done
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Filled 2 of 2 fields on https://github.com with the user\'s input: @e3 "Username or email address" (username), @e6 "Password" (password).')
    expect(result.content[0].text).toContain('Clicked @e7.')
    expect(result.content[0].text).toContain('Page NAVIGATED — now at https://github.com/session')
  })

  it('redacts an injected value from the page the submit led to', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-get-form')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-get-form')).toBe(true))
    rememberInjectedSecret('hunter2-pass')
    inputManager.resolve('login-get-form', JSON.stringify({
      type: 'filled',
      origin: 'https://github.com',
      outcomes: [{ ref: '@e6', kind: 'password', label: 'Password', status: 'filled' }],
      lost: [],
      submitted: { via: 'click', ref: '@e7' },
      observation: { digest: { url: 'https://github.com/session?password=hunter2-pass', navigated: true } },
    }))
    const text = (await done).content[0].text
    expect(text).not.toContain('hunter2-pass')
    expect(text).toContain('password=[redacted]')
  })

  it('names a saved account whole though a value typed into another field is part of its username', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-names')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-names')).toBe(true))
    // The user typed workspace "acme" on an earlier step.
    rememberInjectedSecret('acme')
    inputManager.resolve('login-names', JSON.stringify({
      type: 'accounts',
      site: 'github.com',
      accounts: [{ username: 'jane@acme.com', label: null, parts: ['password'], via: null }],
    }))
    const text = (await done).content[0].text
    expect(text).toContain('- jane@acme.com: holds a password')
  })

  it('redacts a password the page shows that begins with the username, naming the account whole', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-alice')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-alice')).toBe(true))
    rememberInjectedSecret('alice-secret')
    inputManager.resolve('login-alice', JSON.stringify({
      type: 'filled',
      origin: 'https://github.com',
      outcomes: [
        { ref: '@e3', kind: 'username', label: 'Username or email address', status: 'filled' },
        { ref: '@e6', kind: 'password', label: 'Password', status: 'filled' },
      ],
      lost: [],
      submitted: { via: 'click', ref: '@e7' },
      account: { username: 'alice', site: 'github.com', source: 'vault', saved: false, held: [] },
      observation: { digest: { url: 'https://github.com/session?login=alice&password=alice-secret', navigated: true } },
    }))
    const text = (await done).content[0].text
    expect(text).not.toContain('alice-secret')
    expect(text).toContain('from the saved account alice:')
    expect(text).toContain('password=[redacted]')
  })

  it('refuses to park when the browser closed while the fields were located', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      resetBrowserState()
      return new Response(JSON.stringify(prepared), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    inputManager.setCurrentToolUseId('login-closed-mid')
    const result = await handlerFor()(args)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Sign-in request cancelled: the browser was closed.')
    expect(inputManager.hasPending('login-closed-mid')).toBe(false)
  })

  it('reports an unreadable answer without echoing it', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-garbled')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-garbled')).toBe(true))
    inputManager.resolve('login-garbled', 'hunter2-pass')
    const result = await done
    expect(result).toEqual({ content: [{ type: 'text', text: 'The sign-in request ended with an unreadable result.' }], isError: true })
  })

  it('ends as cancelled when the user declines, pointing at the conversation', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-declined')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-declined')).toBe(true))
    inputManager.reject('login-declined', 'The user declined to sign in')
    const result = await done
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Sign-in request cancelled: The user declined to sign in. The user may want to discuss the task with you.')
  })

  it('ends as cancelled when the request is rejected, saying no more than why', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-closing')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-closing')).toBe(true))
    inputManager.rejectByType('login', 'The request timed out before the user completed it')
    const result = await done
    expect(result.content[0].text).toBe('Sign-in request cancelled: The request timed out before the user completed it.')
  })

  it('tells the agent what the user saved while its browser was closed, and how to sign in with it', async () => {
    vi.stubGlobal('fetch', respond(200, prepared))
    inputManager.setCurrentToolUseId('login-closed')
    const done = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-closed')).toBe(true))
    inputManager.resolve('login-closed', JSON.stringify({ type: 'browser_closed', site: 'github.com', kept: { how: 'saved', username: 'octocat' } }))
    const result = await done
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe([
      'The browser was closed before anything went into the page. The user saved the account octocat on github.com to their vault, for you to use.',
      'Open its sign-in page again and call request_login with username "octocat": the host signs in with it.',
    ].join('\n'))

    inputManager.setCurrentToolUseId('login-closed-2')
    const again = handlerFor()(args)
    await vi.waitFor(() => expect(inputManager.hasPending('login-closed-2')).toBe(true))
    inputManager.resolve('login-closed-2', JSON.stringify({ type: 'browser_closed', site: 'github.com' }))
    expect(await again).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Nothing the user entered is kept.') }] })
  })
})

describe('formatLoginResolution when the browser closed first', () => {
  const closed = (kept?: { how: 'saved' | 'picked' | 'vault' | 'held'; username?: string }) =>
    formatLoginResolution({ type: 'browser_closed', site: 'github.com', ...(kept ? { kept } : {}) }).content[0].text

  it('names what the next try signs in with: an account picked, the one the host used, or what is held', () => {
    expect(closed({ how: 'picked', username: 'octocat' })).toBe([
      'The browser was closed before anything went into the page. The user picked their saved account octocat on github.com, for you to use.',
      'Open its sign-in page again and call request_login with username "octocat": the host signs in with it.',
    ].join('\n'))
    expect(closed({ how: 'vault', username: 'octocat' })).toBe([
      'The browser was closed before anything went into the page.',
      'Open its sign-in page again and call request_login with username "octocat": the host signs in with it.',
    ].join('\n'))
    expect(closed({ how: 'held', username: 'octocat' })).toBe([
      'The browser was closed before anything went into the page. The host holds what the user entered for the account octocat on github.com for 30 minutes.',
      'Open its sign-in page again within that time and call request_login with username "octocat": the host fills it in without asking the user again.',
    ].join('\n'))
    // Held from a step that showed no username: the call names none.
    expect(closed({ how: 'held' })).toContain('call request_login: the host fills it in')
  })
})

describe('formatLoginResolution for the vault', () => {
  it('lists the saved accounts the agent may use, what each holds, and how to use one', () => {
    const { content, isError } = formatLoginResolution({
      type: 'accounts',
      site: 'github.com',
      accounts: [
        { username: 'octocat', label: 'Work', parts: ['password', 'text:workspace'], via: null },
        { username: 'me@gmail.com', label: null, parts: [], via: { site: 'google.com', username: 'me@gmail.com', name: 'Google' } },
        { username: 'hubot', label: null, parts: [], via: null },
        { username: 'old@example.com', label: null, parts: ['password'], via: null, rejected: true },
      ],
    })
    expect(isError).toBeUndefined()
    expect(content[0].text).toBe([
      'Nothing was filled. Saved accounts on github.com you may use:',
      '- octocat ("Work"): holds a password and "workspace"',
      '- me@gmail.com: signs in with the Google account me@gmail.com (google.com)',
      '- hubot: no saved password or other value yet',
      '- old@example.com: holds a password (the site rejected its saved password, as reported earlier: using it asks the user)',
      'To sign in with one, call request_login again with username set to it. To ask the user for another account, call it with ask_user: true.',
    ].join('\n'))
  })

  it('names the provider account to pick, and only that one', () => {
    const text = formatLoginResolution({
      type: 'via',
      site: 'medium.com',
      username: 'me@gmail.com',
      provider: { site: 'google.com', username: 'me@gmail.com', name: 'Google' },
      saved: true,
    }).content[0].text
    expect(text).toContain('The user signs in to medium.com with the Google account me@gmail.com, saved to their vault for this site.')
    expect(text).toContain('pick me@gmail.com and no other account')
    expect(text).toContain('call request_login on its page with username "me@gmail.com"')
  })

  it('says the agent named an account but mapped no field, without repeating the call it made', () => {
    const text = formatLoginResolution({
      type: 'accounts',
      site: 'github.com',
      named: true,
      accounts: [{ username: 'octocat', label: null, parts: ['password'], via: null }],
    }).content[0].text
    expect(text).toBe([
      'Nothing was filled: this call mapped no field.',
      '- octocat: holds a password',
      "To sign in with it, call request_login with username set to it and the page's sign-in fields mapped by ref.",
    ].join('\n'))
  })

  it('reports a fill and a held field whose account the host does not know', () => {
    const text = formatLoginResolution({
      type: 'filled',
      origin: 'https://github.com',
      outcomes: [{ ref: '@e3', kind: 'otp', label: 'Code', status: 'filled' }],
      lost: [],
      submitted: { via: 'click', ref: '@e7' },
      account: { site: 'github.com', source: 'user', saved: false, held: ['Password'] },
    }).content[0].text
    expect(text).toContain("Filled 1 of 1 field on https://github.com with the user's input")
    expect(text).toContain('The user also entered "Password" for a later step; the host holds it. When the page asks for it, call request_login and map that field.')
    expect(text).not.toContain('undefined')
  })

  it('says a fill came from a saved account, or was saved, and what is held for the next step', () => {
    const base = {
      type: 'filled' as const,
      origin: 'https://github.com',
      outcomes: [{ ref: '@e3', kind: 'username' as const, label: 'Email', status: 'filled' as const }],
      lost: [],
      submitted: { via: 'click' as const, ref: '@e7' },
    }
    const vault = formatLoginResolution({ ...base, account: { username: 'octocat', site: 'github.com', source: 'vault', saved: false, held: [] } }).content[0].text
    expect(vault).toContain('Filled 1 of 1 field on https://github.com from the saved account octocat: @e3 "Email" (username).')

    const saved = formatLoginResolution({ ...base, account: { username: 'octocat', site: 'github.com', source: 'user', saved: true, held: ['Password'] } }).content[0].text
    expect(saved).toContain("with the user's input for the account octocat")
    expect(saved).toContain('The user saved this to their vault as account octocat on github.com.')
    expect(saved).toContain('The user also entered "Password" for a later step; the host holds it for account octocat. When the page asks for it, call request_login with username "octocat" and map that field.')
  })

  it('names the account the user typed in, saved or not, so the next step can name it', () => {
    const typed = formatLoginResolution({
      type: 'filled',
      origin: 'https://github.com',
      outcomes: [{ ref: '@e3', kind: 'username', label: 'Email', status: 'filled' }],
      lost: [],
      submitted: { via: 'click', ref: '@e7' },
      account: { username: 'octocat', site: 'github.com', source: 'user', saved: false, held: [] },
    }).content[0].text
    expect(typed).toContain('Filled 1 of 1 field on https://github.com with the user\'s input for the account octocat: @e3 "Email" (username).')
  })
})

describe('formatLoginResolution', () => {
  const base: LoginFillReport = { type: 'filled', origin: 'https://example.com', outcomes: [], lost: [], submitted: null }
  const field = (ref: string, status: LoginFillReport['outcomes'][number]['status'], extra = {}) =>
    ({ ref, kind: 'password' as const, label: 'Password', status, ...extra })

  it('reports a sign-in done on the page', () => {
    expect(formatLoginResolution({ type: 'manual' }).content[0].text).toBe(
      'The user signed in on the page themselves and is done. Take a browser snapshot to see the current state.',
    )
  })

  it('says what was not filled and that nothing was submitted, as an error when nothing was filled', () => {
    const result = formatLoginResolution({
      ...base,
      outcomes: [field('@e6', 'failed', { problem: 'the frame holding the fields is now on https://evil.example, not https://example.com' })],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe([
      'No field was filled on https://example.com.',
      '@e6 "Password" (password) was not filled: the frame holding the fields is now on https://evil.example, not https://example.com.',
      'Nothing was clicked or pressed.',
    ].join('\n'))
  })

  it('says a write was sent and returned no answer, not that nothing was filled', () => {
    const result = formatLoginResolution({
      ...base,
      outcomes: [field('@e6', 'unconfirmed', { problem: 'the write into @e6 was sent and returned no answer (timed out)' })],
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe([
      'No write on https://example.com was confirmed.',
      '@e6 "Password" (password): the write into @e6 was sent and returned no answer (timed out).',
      'Nothing was clicked or pressed.',
    ].join('\n'))
  })

  it('names fields the page changed, code boxes, empty fields, what was seen before the submit, and a failed click', () => {
    const text = formatLoginResolution({
      ...base,
      outcomes: [
        { ref: '@e2', kind: 'username', label: 'Phone', status: 'changed' },
        { ref: '@e4', kind: 'otp', label: 'Code', status: 'filled', boxes: 6 },
        { ref: '@e5', kind: 'text', label: 'Company', status: 'skipped' },
      ],
      lost: [{ ref: '@e4', state: 'differs' }, { ref: '@e8', state: 'detached' }, { ref: '@e9', state: 'unreadable', error: 'Runtime.callFunctionOn: timed out' }],
      submitError: 'clicking @e7 failed: ✗ Element is detached',
    }).content[0].text
    expect(text).toContain('@e2 read back different from what the user entered (the page changed it as it was written).')
    expect(text).toContain('@e4: the code went into 6 one-character boxes.')
    expect(text).toContain('@e5 "Company" (text) was left empty by the user.')
    expect(text).toContain('Just before the submit, @e4 held a different value than was written.')
    expect(text).toContain('Just before the submit, @e8 was no longer in its document.')
    expect(text).toContain('Just before the submit, @e9 could not be read back (Runtime.callFunctionOn: timed out).')
    expect(text).toContain('Clicking @e7 failed: ✗ Element is detached.')
    expect(text).not.toContain('not submitted')
  })

  it('says nothing was clicked or pressed when the page rewrote a password or code', () => {
    const text = formatLoginResolution({ ...base, outcomes: [field('@e6', 'changed')], changedSecrets: ['@e6'] }).content[0].text
    expect(text).toContain('Just before the submit, @e6 still held a different value than the user entered; nothing was clicked or pressed.')
  })

  it('reports what the page did by itself, as seen, and that nothing was clicked or pressed', () => {
    const say = (resolution: Partial<Parameters<typeof formatLoginResolution>[0]>) =>
      formatLoginResolution({ ...base, outcomes: [field('@e6', 'filled')], ...resolution } as Parameters<typeof formatLoginResolution>[0]).content[0].text
    expect(say({ submitted: { via: 'page' } })).toContain('A submit event fired in the page as the values went in; nothing was clicked or pressed.')
    expect(say({ pageActivity: { kind: 'navigation', url: 'https://example.com/2fa?code=1#x' } }))
      .toContain('After the values went in, the page started loading https://example.com/2fa; nothing was clicked or pressed.')
    expect(say({ pageActivity: { kind: 'request', method: 'POST', url: 'https://example.com/verify?otp=482913' } }))
      .toContain('After the code went in, the page sent it in a POST to https://example.com/verify; nothing was clicked or pressed.')
    expect(say({ pageActivity: { kind: 'detached', ref: '@e6' } })).toContain('After the values went in, @e6 was no longer in its document; nothing was clicked or pressed.')
    expect(say({ pageActivity: { kind: 'locked', ref: '@e6' } })).toContain('After the values went in, @e6 became disabled or read-only; nothing was clicked or pressed.')
    expect(say({ pageActivity: { kind: 'gone' } })).toContain('After the values went in, the document that held the fields was gone; nothing was clicked or pressed.')
    expect(say({ pageActivity: { kind: 'unreadable', error: 'timed out' } })).toContain('After the values went in, the page could not be read (timed out); nothing was clicked or pressed.')
  })

  it('says when the CLI refused the click and the page clicked the control instead', () => {
    const text = formatLoginResolution({
      ...base,
      outcomes: [{ ref: '@e28', kind: 'username', label: 'Username', status: 'filled' }, field('@e52', 'filled')],
      submitted: { via: 'click-in-page', ref: '@e29', clickError: "✗ Element '@e29' is covered by <div#onetrust-policy-text> at its click point." },
    }).content[0].text
    expect(text).toContain("The CLI did not click @e29 (✗ Element '@e29' is covered by <div#onetrust-policy-text> at its click point); it was clicked from inside the page instead.")
  })

  it('reports an Enter press in the last filled field, and a new tab instead of the page effect', () => {
    const text = formatLoginResolution({
      ...base,
      outcomes: [{ ref: '@e2', kind: 'username', label: 'Email', status: 'filled' }, field('@e3', 'filled')],
      submitted: { via: 'enter' },
      observation: { tabInfo: { activeId: 't2', activeUrl: 'https://example.com/welcome', tabCount: 2 } },
    }).content[0].text
    expect(text).toContain('Pressed Enter in @e3.')
    expect(text).toContain('New tab opened — you are now on tab t2 (https://example.com/welcome)')
  })
})
