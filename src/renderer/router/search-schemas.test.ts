import { describe, it, expect } from 'vitest'
import {
  chatSearchSchema,
  connectionsSearchSchema,
  homeSearchSchema,
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
    expect(connectionsSearchSchema.safeParse({ detail: 'account-9', source: 'home', connectionView: 'logs' }).success).toBe(true)
  })
  it('rejects logs without a selected connection', () => {
    expect(connectionsSearchSchema.safeParse({ connectionView: 'logs' }).success).toBe(false)
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
    expect(settingsTabSchema.safeParse('web').success).toBe(true)
  })
  it('rejects an unknown tab', () => {
    expect(settingsTabSchema.safeParse('garbage').success).toBe(false)
  })
  it('rejects the agent-scoped dialogs that are NOT global settings tabs', () => {
    expect(settingsTabSchema.safeParse('system-prompt').success).toBe(false)
    expect(settingsTabSchema.safeParse('secrets').success).toBe(false)
  })
  it('has 21 tabs', () => {
    expect(SETTINGS_TABS).toHaveLength(21)
    expect(settingsTabSchema.safeParse('capabilities').success).toBe(true)
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
  it('accepts connection logs only with a selected connection', () => {
    expect(settingsSearchSchema.safeParse({ detail: 'account-1', connectionView: 'logs' }).success).toBe(true)
    expect(settingsSearchSchema.safeParse({ connectionView: 'logs' }).success).toBe(false)
  })
})

// rootSearchSchema.redirect and settingsSearchSchema.from share ONE guard
// with api.ts `isSafeInternalPath`, so the schema rejects every open-redirect
// form the sanitizer does — no asymmetry left to drift.
describe('rootSearchSchema.redirect == api.ts isSafeInternalPath (unified guard)', () => {
  it('rejects backslash-UNC `/\\host`', () => {
    expect(rootSearchSchema.safeParse({ redirect: '/\\evil.com' }).success).toBe(false)
  })
  it('rejects a leading encoded separator `/%2fhost`', () => {
    expect(rootSearchSchema.safeParse({ redirect: '/%2fevil' }).success).toBe(false)
  })
  it('rejects protocol-relative `//host`', () => {
    expect(rootSearchSchema.safeParse({ redirect: '//evil.com' }).success).toBe(false)
  })
  it('still accepts a normal internal path and a deeper (non-leading) encoded separator', () => {
    expect(rootSearchSchema.safeParse({ redirect: '/agents/foo' }).success).toBe(true)
    expect(rootSearchSchema.safeParse({ redirect: '/settings/general?from=%2Fagents%2Ffoo' }).success).toBe(true)
  })
})

describe('homeSearchSchema (signup handoff)', () => {
  it('truncates an over-length prompt instead of dropping it', () => {
    const parsed = lenient(homeSearchSchema)({ prompt: 'x'.repeat(500) })
    expect(parsed.prompt).toHaveLength(400)
  })

  it('applies per-field catch: keeps a valid prompt when the model is junk', () => {
    const parsed = lenient(homeSearchSchema)({ prompt: 'hello', model: 'not valid' })
    expect(parsed.prompt).toBe('hello')
    expect(parsed.model).toBeUndefined()
    expect(lenient(homeSearchSchema)({ prompt: 1, model: '!!!' })).toEqual({})
  })

  it('keeps handoff params when view is invalid', () => {
    expect(
      lenient(homeSearchSchema)({
        view: 'garbage',
        prompt: 'hello',
        model: 'claude-opus-5',
      }),
    ).toEqual({ prompt: 'hello', model: 'claude-opus-5' })
  })

  // Parity with withSignupHandoff (platform-sso-start.ts): a directly-visited
  // URL skips the SSO hop, so the schema has to be the same gate on its own.
  it('strips control characters and trims, matching the SSO hop', () => {
    expect(lenient(homeSearchSchema)({ prompt: '  build\r\nand ship\0  ' }).prompt)
      .toBe('buildand ship')
  })

  it('strips before capping so control characters do not eat the budget', () => {
    const parsed = lenient(homeSearchSchema)({ prompt: `${'\n'.repeat(200)}${'x'.repeat(500)}` })
    expect(parsed.prompt).toBe('x'.repeat(400))
  })

  it('collapses an all-whitespace prompt to falsy so consumers read it as absent', () => {
    expect(lenient(homeSearchSchema)({ prompt: '   \r\n  ' }).prompt).toBe('')
  })

  it('drops a junk template_slug and keeps a valid prompt', () => {
    const parsed = lenient(homeSearchSchema)({
      prompt: 'hello',
      template_slug: 'not valid!',
    })
    expect(parsed.prompt).toBe('hello')
    expect(parsed.template_slug).toBeUndefined()
  })

  it('accepts a valid template_slug', () => {
    expect(lenient(homeSearchSchema)({ template_slug: 'my.agent-v2' }).template_slug).toBe('my.agent-v2')
  })
})
