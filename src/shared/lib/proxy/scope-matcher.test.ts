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
})
