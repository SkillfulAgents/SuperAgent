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

  it('takes one to six fields of a known kind', () => {
    const base = { sessionId: 's', toolUseId: 't', submitRef: null }
    expect(loginPrepareRequestSchema.safeParse({ ...base, fields: [] }).success).toBe(false)
    expect(loginPrepareRequestSchema.safeParse({ ...base, fields: [{ ref: '@e1', kind: 'pin', label: 'PIN' }] }).success).toBe(false)
    const ok = loginPrepareRequestSchema.parse({ ...base, fields: [{ ref: 'e1', kind: 'otp', label: ' Code ' }] })
    expect(ok.fields[0]).toEqual({ ref: '@e1', kind: 'otp', label: 'Code' })
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
