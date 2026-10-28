import { describe, expect, it } from 'vitest'
import { elementRefSchema, loginFillRequestSchema, loginPrepareRequestSchema, loginResolutionSchema } from './login-schema'

describe('login schemas', () => {
  it('normalizes refs to the CLI form and rejects anything else', () => {
    expect(elementRefSchema.parse('e12')).toBe('@e12')
    expect(elementRefSchema.parse(' @e7 ')).toBe('@e7')
    for (const bad of ['#password', 'e', '@e12; rm -rf', 'input[name=pw]']) {
      expect(elementRefSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('takes up to six fields of a known kind, a ref optional', () => {
    const base = { sessionId: 's', toolUseId: 't', submitRef: null }
    // None is a page that offers only "Continue with Google": the main frame is the site.
    expect(loginPrepareRequestSchema.safeParse({ ...base, fields: [] }).success).toBe(true)
    expect(loginPrepareRequestSchema.safeParse({ ...base, fields: [{ ref: '@e1', kind: 'pin', label: 'PIN' }] }).success).toBe(false)
    const ok = loginPrepareRequestSchema.parse({ ...base, fields: [{ ref: 'e1', kind: 'otp', label: ' Code ' }] })
    expect(ok.fields[0]).toEqual({ ref: '@e1', kind: 'otp', label: 'Code' })
    // A later step's field, asked now: no ref.
    expect(loginPrepareRequestSchema.parse({ ...base, fields: [{ kind: 'password', label: 'Password' }] }).fields[0]).toEqual({ kind: 'password', label: 'Password' })
    expect(loginPrepareRequestSchema.safeParse({ ...base, fields: Array.from({ length: 7 }, (_, i) => ({ ref: `@e${i}`, kind: 'text', label: 'x' })) }).success).toBe(false)
  })

  it('rejects unknown keys in a fill, so nothing else can ride along with the values', () => {
    const fill = { sessionId: 's', toolUseId: 't', expectedOrigin: 'https://a.com', values: ['x'] }
    expect(loginFillRequestSchema.safeParse(fill).success).toBe(true)
    expect(loginFillRequestSchema.safeParse({ ...fill, selector: '#pw' }).success).toBe(false)
  })

  it('reads both ways a request can end', () => {
    expect(loginResolutionSchema.parse({ type: 'manual' })).toEqual({ type: 'manual' })
    expect(loginResolutionSchema.safeParse({ type: 'filled', origin: 'https://a.com', outcomes: [], lost: [], submitted: { via: 'enter' } }).success).toBe(true)
    expect(loginResolutionSchema.safeParse({ type: 'filled', origin: 'https://a.com', outcomes: [], lost: [], submitted: { via: 'magic' } }).success).toBe(false)
  })
})
