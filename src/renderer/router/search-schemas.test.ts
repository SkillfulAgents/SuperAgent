import { describe, it, expect } from 'vitest'
import {
  chatSearchSchema,
  connectionsSearchSchema,
  rootSearchSchema,
  settingsSearchSchema,
  settingsTabSchema,
  SETTINGS_TABS,
} from './search-schemas'
import { lenient } from './zod-search'

describe('rootSearchSchema (open-redirect safety)', () => {
  it('rejects absolute URLs', () => {
    expect(rootSearchSchema.safeParse({ redirect: 'https://evil.com' }).success).toBe(false)
  })
  it('rejects protocol-relative //', () => {
    expect(rootSearchSchema.safeParse({ redirect: '//evil.com' }).success).toBe(false)
  })
  it('accepts an internal absolute path', () => {
    expect(rootSearchSchema.safeParse({ redirect: '/agents/a' }).success).toBe(true)
  })
  it('accepts no redirect', () => {
    expect(rootSearchSchema.safeParse({}).success).toBe(true)
  })
})

describe('connectionsSearchSchema (detail+source coupling)', () => {
  it('rejects detail without source', () => {
    expect(connectionsSearchSchema.safeParse({ detail: 'account-1' }).success).toBe(false)
  })
  it('rejects source without detail', () => {
    expect(connectionsSearchSchema.safeParse({ source: 'home' }).success).toBe(false)
  })
  it('accepts account/mcp detail with a source', () => {
    expect(connectionsSearchSchema.safeParse({ detail: 'mcp-1', source: 'list' }).success).toBe(true)
    expect(connectionsSearchSchema.safeParse({ detail: 'account-9', source: 'home' }).success).toBe(true)
  })
  it('rejects a malformed detail prefix', () => {
    expect(connectionsSearchSchema.safeParse({ detail: 'garbage', source: 'home' }).success).toBe(false)
  })
  it('accepts neither', () => {
    expect(connectionsSearchSchema.safeParse({}).success).toBe(true)
  })
})

describe('chatSearchSchema', () => {
  it('round-trips an optional session', () => {
    expect(chatSearchSchema.parse({ session: 'cs-1' })).toEqual({ session: 'cs-1' })
  })
  it('accepts a missing session', () => {
    expect(chatSearchSchema.parse({})).toEqual({})
  })
})

describe('lenient wrapper', () => {
  it('falls back to {} on invalid search', () => {
    expect(lenient(connectionsSearchSchema)({ detail: 'garbage' })).toEqual({})
  })
  it('returns parsed data on valid search', () => {
    expect(lenient(chatSearchSchema)({ session: 'x' })).toEqual({ session: 'x' })
  })
  it('strips unknown keys (zod .object() default) and keeps the known field', () => {
    expect(lenient(chatSearchSchema)({ session: 'x', junk: 1 })).toEqual({ session: 'x' })
  })
  it('falls back to {} when a refine rejects a structurally-valid half-pair', () => {
    // `detail: 'account-1'` passes the /^(account|mcp)-.+$/ regex, so only the
    // detail+source coupling refine fails → lenient must degrade to {}, not throw.
    expect(lenient(connectionsSearchSchema)({ detail: 'account-1' })).toEqual({})
  })
})

describe('settingsTabSchema', () => {
  it('accepts a known tab', () => {
    expect(settingsTabSchema.safeParse('general').success).toBe(true)
  })
  it('rejects an unknown tab', () => {
    expect(settingsTabSchema.safeParse('garbage').success).toBe(false)
  })
  it('rejects the agent-scoped dialogs that are NOT global settings tabs', () => {
    expect(settingsTabSchema.safeParse('system-prompt').success).toBe(false)
    expect(settingsTabSchema.safeParse('secrets').success).toBe(false)
  })
  it('has 18 tabs', () => {
    expect(SETTINGS_TABS).toHaveLength(18)
  })
})

describe('settingsSearchSchema (from close-target)', () => {
  it('rejects an absolute URL', () => {
    expect(settingsSearchSchema.safeParse({ from: 'https://evil.com' }).success).toBe(false)
  })
  it('rejects a protocol-relative //', () => {
    expect(settingsSearchSchema.safeParse({ from: '//evil' }).success).toBe(false)
  })
  it('accepts an internal absolute path', () => {
    expect(settingsSearchSchema.safeParse({ from: '/settings/general' }).success).toBe(true)
  })
  it('accepts no from', () => {
    expect(settingsSearchSchema.safeParse({}).success).toBe(true)
  })
})

// The schema regex `/^\/(?!\/)/` only blocks protocol-relative `//host`. It
// deliberately ACCEPTS backslash-UNC `/\host` and a leading encoded `/%2fhost`
// that the REAL open-redirect backstop — api.ts `isSafeInternalPath`, pinned in
// api.test.ts — rejects. This pins that asymmetry so nobody mistakes the search
// schema (a shape gate) for the sanitizer (applied on the actual redirect path).
describe('rootSearchSchema vs api.ts isSafeInternalPath (intentional asymmetry)', () => {
  it('ACCEPTS backslash-UNC `/\\host` that isSafeInternalPath rejects', () => {
    expect(rootSearchSchema.safeParse({ redirect: '/\\evil.com' }).success).toBe(true)
  })
  it('ACCEPTS a leading encoded separator `/%2fhost` that isSafeInternalPath rejects', () => {
    expect(rootSearchSchema.safeParse({ redirect: '/%2fevil' }).success).toBe(true)
  })
  it('still rejects the protocol-relative `//host` the regex DOES catch', () => {
    expect(rootSearchSchema.safeParse({ redirect: '//evil.com' }).success).toBe(false)
  })
})
