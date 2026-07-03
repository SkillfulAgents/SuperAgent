import { describe, it, expect } from 'vitest'
import { buildChatRows, isBrowsable } from './chat-inbox-model'
import { makeSession as session, makeAccess as access } from './test-factories'

describe('buildChatRows', () => {
  it('collapses a chat\'s windows into one row, newest-first', () => {
    const rows = buildChatRows(
      [
        session({ externalChatId: 'c1', sessionId: 's-old', updatedAt: new Date('2026-06-19T10:00:00Z') }),
        session({ externalChatId: 'c1', sessionId: 's-new', updatedAt: new Date('2026-06-20T10:00:00Z') }),
      ],
      [],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].windows.map((w) => w.sessionId)).toEqual(['s-new', 's-old'])
    expect(rows[0].latestSessionId).toBe('s-new')
    expect(isBrowsable(rows[0])).toBe(true)
  })

  it('orders active/allowed by recency, with blocked (pending + denied) at the bottom', () => {
    const rows = buildChatRows(
      [
        session({ externalChatId: 'allowed-old', sessionId: 's1', updatedAt: new Date('2026-06-10T00:00:00Z') }),
        session({ externalChatId: 'allowed-new', sessionId: 's2', updatedAt: new Date('2026-06-21T00:00:00Z') }),
      ],
      [
        access({ externalChatId: 'allowed-old', status: 'allowed' }),
        access({ externalChatId: 'allowed-new', status: 'allowed' }),
        // Pending is recent but still sinks below allowed chats; denied last within the blocked group.
        access({ externalChatId: 'waiting', status: 'pending', requestedAt: new Date('2026-06-22T00:00:00Z') }),
        access({ externalChatId: 'blocked', status: 'denied' }),
      ],
    )
    expect(rows.map((r) => r.externalChatId)).toEqual(['allowed-new', 'allowed-old', 'waiting', 'blocked'])
  })

  it('sorts the blocked group by first contact, so a fresh denial does not jump ahead of a waiting chat', () => {
    const rows = buildChatRows(
      [],
      [
        // Denied just now (recent decidedAt) but first messaged long ago - must not float up.
        access({ externalChatId: 'spam', status: 'denied', requestedAt: new Date('2026-06-10T00:00:00Z'), decidedAt: new Date('2026-06-22T00:00:00Z') }),
        // Still waiting; arrived after the spammer first did.
        access({ externalChatId: 'waiting', status: 'pending', requestedAt: new Date('2026-06-15T00:00:00Z') }),
      ],
    )
    expect(rows.map((r) => r.externalChatId)).toEqual(['waiting', 'spam'])
  })

  it('keeps a blocked chat with preserved sessions below a still-waiting chat', () => {
    const rows = buildChatRows(
      [session({ externalChatId: 'blocked-active', sessionId: 's', updatedAt: new Date('2026-06-30T00:00:00Z') })],
      [
        access({ externalChatId: 'blocked-active', status: 'denied', requestedAt: new Date('2026-06-01T00:00:00Z'), decidedAt: new Date('2026-06-25T00:00:00Z') }),
        access({ externalChatId: 'waiting', status: 'pending', requestedAt: new Date('2026-06-20T00:00:00Z') }),
      ],
    )
    expect(rows.map((r) => r.externalChatId)).toEqual(['waiting', 'blocked-active'])
  })

  it('keeps pending/denied chats with no windows and surfaces their preview', () => {
    const rows = buildChatRows(
      [],
      [access({ externalChatId: 'p', status: 'pending', title: 'Dana', firstMessagePreview: 'hi there' })],
    )
    expect(rows[0].windows).toHaveLength(0)
    expect(rows[0].latestSessionId).toBeNull()
    expect(isBrowsable(rows[0])).toBe(false)
    expect(rows[0].title).toBe('Dana')
    expect(rows[0].firstMessagePreview).toBe('hi there')
  })

  it('derives chat rows from sessions alone (Slack: no access)', () => {
    const rows = buildChatRows(
      [session({ externalChatId: 'C123', sessionId: 's', displayName: '#general' })],
      undefined,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBeUndefined()
    expect(rows[0].title).toBe('#general')
    expect(rows[0].accessId).toBeUndefined()
  })

  it('names a no-access chat from its newest window, not the oldest', () => {
    // Same chat, renamed between windows: the current (newest) name should win.
    const rows = buildChatRows(
      [
        session({ externalChatId: 'c1', sessionId: 's-old', displayName: 'Old Name', updatedAt: new Date('2026-06-19T10:00:00Z') }),
        session({ externalChatId: 'c1', sessionId: 's-new', displayName: 'New Name', updatedAt: new Date('2026-06-20T10:00:00Z') }),
      ],
      [],
    )
    expect(rows[0].title).toBe('New Name')
  })

  it('falls through to an older window name when the newest window is unnamed', () => {
    // Newest window has no displayName; the title should adopt the next-newest NAMED
    // window rather than dropping to the "Chat <id>" fallback.
    const rows = buildChatRows(
      [
        session({ externalChatId: 'c1', sessionId: 's-old', displayName: 'Dana', updatedAt: new Date('2026-06-19T10:00:00Z') }),
        session({ externalChatId: 'c1', sessionId: 's-new', displayName: null, updatedAt: new Date('2026-06-20T10:00:00Z') }),
      ],
      [],
    )
    expect(rows[0].title).toBe('Dana')
  })

  it('prefers the access title over a session display name', () => {
    const rows = buildChatRows(
      [session({ externalChatId: 'c1', sessionId: 's', displayName: 'stale name' })],
      [access({ externalChatId: 'c1', status: 'allowed', title: 'Canonical Title' })],
    )
    expect(rows[0].title).toBe('Canonical Title')
  })

  it('falls back to a short id when nothing is named', () => {
    const rows = buildChatRows([session({ externalChatId: 'abcdef123456', sessionId: 's' })], [])
    expect(rows[0].title).toBe('Chat 123456')
  })
})
