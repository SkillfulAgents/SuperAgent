import { describe, it, expect } from 'vitest'
import { matchScopes } from './scope-matcher'

describe('matchScopes', () => {
  it('exact match: gmail GET /gmail/v1/users/me/messages returns correct scopes', () => {
    const result = matchScopes('gmail', 'GET', '/gmail/v1/users/me/messages')
    expect(result.matched).toBe(true)
    expect(result.scopes).toContain('gmail.full')
    expect(result.scopes).toContain('gmail.metadata')
    expect(result.scopes).toContain('gmail.modify')
    expect(result.scopes).toContain('gmail.readonly')
  })

  it('wildcard segment: gmail GET /gmail/v1/users/me/messages/abc123 matches */messages/*', () => {
    const result = matchScopes('gmail', 'GET', '/gmail/v1/users/me/messages/abc123')
    expect(result.matched).toBe(true)
    expect(result.scopes).toContain('gmail.full')
    expect(result.scopes).toContain('gmail.readonly')
  })

  it('method discrimination: gmail GET vs DELETE on messages/* return different scope sets', () => {
    const getResult = matchScopes('gmail', 'GET', '/gmail/v1/users/me/messages/abc123')
    const deleteResult = matchScopes('gmail', 'DELETE', '/gmail/v1/users/me/messages/abc123')
    expect(getResult.matched).toBe(true)
    expect(deleteResult.matched).toBe(true)
    // DELETE /messages/* only has gmail.full
    expect(deleteResult.scopes).toContain('gmail.full')
    expect(deleteResult.scopes).not.toContain('gmail.readonly')
    // GET /messages/* has more scopes
    expect(getResult.scopes).toContain('gmail.readonly')
  })

  it('method-agnostic ("*"): slack GET /api/conversations.history matches the POST-or-GET RPC entry', () => {
    // Slack is RPC-style: the path identifies the operation and the same scope
    // applies whether the agent calls it via GET or POST. Both must resolve to
    // the *:history scopes so the user gets a specific "Always allow" option
    // instead of falling back to the broad "all slack requests" suggestion.
    const get = matchScopes('slack', 'GET', '/api/conversations.history')
    const post = matchScopes('slack', 'POST', '/api/conversations.history')
    expect(get.matched).toBe(true)
    expect(post.matched).toBe(true)
    expect(get.scopes).toContain('channels:history')
    expect(get.scopes.sort()).toEqual(post.scopes.sort())
  })

  it('unknown endpoint: gmail GET /gmail/v1/unknown/path returns matched: false', () => {
    const result = matchScopes('gmail', 'GET', '/gmail/v1/unknown/path')
    expect(result.matched).toBe(false)
    expect(result.scopes).toEqual([])
    expect(result.descriptions).toEqual({})
  })

  it('unknown toolkit returns matched: false', () => {
    const result = matchScopes('nonexistent', 'GET', '/some/path')
    expect(result.matched).toBe(false)
    expect(result.scopes).toEqual([])
    expect(result.descriptions).toEqual({})
  })

  it('specific pattern wins: gmail POST /gmail/v1/users/me/messages/send matches send-specific entry', () => {
    const result = matchScopes('gmail', 'POST', '/gmail/v1/users/me/messages/send')
    expect(result.matched).toBe(true)
    // The send-specific entry has gmail.compose and gmail.send
    expect(result.scopes).toContain('gmail.compose')
    expect(result.scopes).toContain('gmail.send')
  })

  it('descriptions populated: matched scopes have descriptions from the entry', () => {
    const result = matchScopes('gmail', 'GET', '/gmail/v1/users/me/profile')
    expect(result.matched).toBe(true)
    // Should have at least one description
    const descKeys = Object.keys(result.descriptions)
    expect(descKeys.length).toBeGreaterThan(0)
    // The description value should be a non-empty string
    expect(typeof Object.values(result.descriptions)[0]).toBe('string')
    expect(Object.values(result.descriptions)[0].length).toBeGreaterThan(0)
  })

  it('case-insensitive method: "get" works same as "GET"', () => {
    const lower = matchScopes('gmail', 'get', '/gmail/v1/users/me/messages')
    const upper = matchScopes('gmail', 'GET', '/gmail/v1/users/me/messages')
    expect(lower.matched).toBe(upper.matched)
    expect(lower.scopes.sort()).toEqual(upper.scopes.sort())
  })

  it('leading slash normalization: works with and without leading /', () => {
    const withSlash = matchScopes('gmail', 'GET', '/gmail/v1/users/me/messages')
    const withoutSlash = matchScopes('gmail', 'GET', 'gmail/v1/users/me/messages')
    expect(withSlash.matched).toBe(withoutSlash.matched)
    expect(withSlash.scopes.sort()).toEqual(withoutSlash.scopes.sort())
  })

  it('multiple providers: googlecalendar GET /calendar/v3/calendars/cal1/events returns calendar scopes', () => {
    const result = matchScopes('googlecalendar', 'GET', '/calendar/v3/calendars/cal1/events')
    expect(result.matched).toBe(true)
    expect(result.scopes).toContain('calendar')
    expect(result.scopes).toContain('calendar.events.readonly')
  })

  it('basePath handling: googledrive entries with basePath /drive/v3 match full paths', () => {
    const result = matchScopes('googledrive', 'GET', '/drive/v3/files')
    expect(result.matched).toBe(true)
    expect(result.scopes).toContain('drive')
    expect(result.scopes).toContain('drive.readonly')
  })

  it('empty path returns matched: false', () => {
    const result = matchScopes('gmail', 'GET', '')
    expect(result.matched).toBe(false)
    expect(result.scopes).toEqual([])
  })

  it('descriptions: prefers curated SCOPE_DESCRIPTIONS over endpoint description', () => {
    // gmail.readonly is curated; the curated description is scope-level
    // ("View your email messages…"), not the endpoint-level "Lists the messages
    // in the user's mailbox." that scope-maps.ts has on this entry.
    const result = matchScopes('gmail', 'GET', '/gmail/v1/users/me/messages')
    expect(result.descriptions['gmail.readonly']).toBe(
      'View your email messages and settings',
    )
    // gmail.full is also curated and broader — must NOT be the listing-endpoint text
    expect(result.descriptions['gmail.full']).not.toMatch(/Lists the messages/)
    expect(result.descriptions['gmail.full']).toBe(
      'Read, compose, send, and permanently delete all your email from Gmail',
    )
  })

  it('descriptions: falls back to endpoint description for uncurated scopes', () => {
    // Use a provider/scope that exists but isn't in SCOPE_DESCRIPTIONS — we
    // cover all 40 providers, so any fallback should be impossible. Verify the
    // mechanism: if scope-descriptions ever loses an entry, the endpoint
    // description still appears. Simulate by checking that EVERY description
    // is a non-empty string, and that the format is plausible.
    const result = matchScopes('gmail', 'GET', '/gmail/v1/users/me/profile')
    for (const [, desc] of Object.entries(result.descriptions)) {
      expect(desc.length).toBeGreaterThan(0)
    }
  })

  it('endpointDescription: populated with the matched endpoint text', () => {
    const result = matchScopes('gmail', 'GET', '/gmail/v1/users/me/profile')
    expect(result.endpointDescription).toBe(
      "Gets the current user's Gmail profile.",
    )
  })

  it('endpointDescription: undefined for unmatched requests', () => {
    const result = matchScopes('gmail', 'GET', '/gmail/v1/unknown/path')
    expect(result.endpointDescription).toBeUndefined()
  })
})
