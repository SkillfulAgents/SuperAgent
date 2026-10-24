import { describe, expect, it } from 'vitest'
import { compactLoginCode, fillLoginBodySchema, isInsecureOrigin, loginContextSchema, siteLabel, summarizeLoginFields } from './login-request'
import { requestLoginDef } from './definition'

describe('login request helpers', () => {
  it('keeps only fields of a known kind from the model\'s input, with a fallback label', () => {
    expect(summarizeLoginFields([
      { ref: '@e1', kind: 'username', label: ' Email ' },
      { ref: '@e2', kind: 'pin', label: 'PIN' },
      'junk',
      null,
      { ref: '@e3', kind: 'password' },
    ])).toEqual([
      { kind: 'username', label: 'Email' },
      { kind: 'password', label: 'password' },
    ])
    expect(summarizeLoginFields('not an array')).toEqual([])
    expect(summarizeLoginFields(Array.from({ length: 10 }, () => ({ kind: 'text', label: 'x' })))).toHaveLength(6)
  })

  it('accepts only a web origin as the context\'s site', () => {
    const context = {
      origin: 'https://github.com', url: 'https://github.com/login', topOrigin: 'https://github.com', submit: true,
      fields: [{ kind: 'username', label: 'Email', inputType: 'email', inputMode: '', autocomplete: 'username', maxLength: -1 }],
    }
    expect(loginContextSchema.safeParse(context).success).toBe(true)
    for (const origin of ['null', 'file://', 'https://github.com/login', 'javascript:alert(1)']) {
      expect(loginContextSchema.safeParse({ ...context, origin }).success).toBe(false)
      expect(loginContextSchema.safeParse({ ...context, topOrigin: origin }).success).toBe(false)
    }
  })

  it('takes the values and the vault options in a fill body, and nothing else', () => {
    const base = { toolUseId: 't', origin: 'https://a.com', values: ['x'] }
    expect(fillLoginBodySchema.safeParse(base).success).toBe(true)
    expect(fillLoginBodySchema.safeParse({
      ...base,
      heldValues: ['next'],
      save: true,
      username: 'me@a.com',
      accountId: 'acc-1',
      sharedAgentAcknowledged: true,
    }).success).toBe(true)
    expect(fillLoginBodySchema.safeParse({ ...base, refs: ['@e1'] }).success).toBe(false)
    expect(fillLoginBodySchema.safeParse({ ...base, origin: undefined }).success).toBe(false)
    expect(fillLoginBodySchema.safeParse({ ...base, values: Array.from({ length: 7 }, () => 'x') }).success).toBe(false)
  })

  it('names the site by its host, keeping a port that is not the default', () => {
    expect(siteLabel('https://www.github.com')).toBe('github.com')
    expect(siteLabel('https://accounts.google.com')).toBe('accounts.google.com')
    expect(siteLabel('https://github.com:443')).toBe('github.com')
    expect(siteLabel('http://intranet.example:8080')).toBe('intranet.example:8080')
    expect(siteLabel('not a url')).toBe('not a url')
  })

  it('compacts a code as the page takes it, limiting the code rather than what was pasted', () => {
    const numeric = { inputType: 'text', inputMode: 'numeric', maxLength: 6 }
    expect(compactLoginCode('123 456', numeric)).toBe('123456')
    expect(compactLoginCode(' 123-456 ', numeric)).toBe('123456')
    expect(compactLoginCode('1234567', numeric)).toBe('123456')
    // A text field may use hyphens in its codes; one-character boxes set no limit.
    expect(compactLoginCode('AB-12 34', { inputType: 'text', inputMode: '', maxLength: -1 })).toBe('AB-1234')
    expect(compactLoginCode('123 456', { inputType: 'tel', inputMode: '', maxLength: 1 })).toBe('123456')
  })

  it('flags plain HTTP, except on this machine', () => {
    expect(isInsecureOrigin('http://bank.example')).toBe(true)
    expect(isInsecureOrigin('https://bank.example')).toBe(false)
    expect(isInsecureOrigin('http://localhost:3000')).toBe(false)
    expect(isInsecureOrigin('http://127.0.0.1:8080')).toBe(false)
  })

  it('tells voice the user must sign in in the app', () => {
    const text = requestLoginDef.request.describeVoice({
      kind: 'login', key: 'k', toolUseId: 'k', message: 'Sign in to GitHub.',
      fields: [{ kind: 'username', label: 'Email' }, { kind: 'password', label: 'Password' }], onComplete: () => {},
    })
    expect(text).toBe('The agent needs the user to sign in through the form in the app (email, password): Sign in to GitHub. Credentials can\'t be given by voice.')
  })
})
