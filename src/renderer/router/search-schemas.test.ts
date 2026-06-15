import { describe, it, expect } from 'vitest'
import {
  chatSearchSchema,
  connectionsSearchSchema,
  rootSearchSchema,
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
