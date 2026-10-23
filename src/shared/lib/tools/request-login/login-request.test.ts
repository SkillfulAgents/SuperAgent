import { describe, expect, it } from 'vitest'
import { fillLoginBodySchema, isInsecureOrigin, loginContextSchema, siteLabel, summarizeLoginFields } from './login-request'
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

  it('rejects a fill body with anything beyond the origin and the values', () => {
    expect(fillLoginBodySchema.safeParse({ toolUseId: 't', origin: 'https://a.com', values: ['x'] }).success).toBe(true)
    expect(fillLoginBodySchema.safeParse({ toolUseId: 't', origin: 'https://a.com', values: ['x'], refs: ['@e1'] }).success).toBe(false)
    expect(fillLoginBodySchema.safeParse({ toolUseId: 't', origin: 'https://a.com', values: [] }).success).toBe(false)
  })

  it('names the site by its host, keeping a port that is not the default', () => {
    expect(siteLabel('https://www.github.com')).toBe('github.com')
    expect(siteLabel('https://accounts.google.com')).toBe('accounts.google.com')
    expect(siteLabel('https://github.com:443')).toBe('github.com')
    expect(siteLabel('http://intranet.example:8080')).toBe('intranet.example:8080')
    expect(siteLabel('not a url')).toBe('not a url')
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
