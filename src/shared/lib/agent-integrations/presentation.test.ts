import { describe, it, expect } from 'vitest'
import { formatProviderName, formatSessionTimestamp, isSettling } from './presentation'

describe('formatProviderName', () => {
  it('capitalizes telegram', () => {
    expect(formatProviderName('telegram')).toBe('Telegram')
  })

  it('capitalizes slack', () => {
    expect(formatProviderName('slack')).toBe('Slack')
  })

  it('handles already-capitalized input', () => {
    expect(formatProviderName('Telegram')).toBe('Telegram')
  })

  it('handles single character', () => {
    expect(formatProviderName('x')).toBe('X')
  })

  it('handles empty string', () => {
    expect(formatProviderName('')).toBe('')
  })
})

describe('isSettling', () => {
  it('is true only when active but not yet connected (the "Connecting…" state)', () => {
    expect(isSettling('active', false)).toBe(true)
    expect(isSettling('active', undefined)).toBe(true)
  })

  it('is false once connected, and for every non-active status', () => {
    expect(isSettling('active', true)).toBe(false)
    expect(isSettling('paused', false)).toBe(false)
    expect(isSettling('error', false)).toBe(false)
    expect(isSettling('disconnected', false)).toBe(false)
  })
})

// ── formatSessionTimestamp ─────────────────────────────────────────────

describe('formatSessionTimestamp', () => {
  it('includes month, day, and time', () => {
    const result = formatSessionTimestamp(new Date('2026-05-20T14:30:00'))
    expect(result).toContain('May')
    expect(result).toContain('20')
    expect(result).toMatch(/2:30\s*PM/)
  })

  it('uses 12-hour format with AM/PM', () => {
    const morning = formatSessionTimestamp(new Date('2026-01-15T09:05:00'))
    expect(morning).toMatch(/9:05\s*AM/)
    expect(morning).toContain('Jan')
    expect(morning).toContain('15')
  })

  it('handles midnight correctly', () => {
    const midnight = formatSessionTimestamp(new Date('2026-03-01T00:00:00'))
    expect(midnight).toMatch(/12:00\s*AM/)
  })

  it('handles noon correctly', () => {
    const noon = formatSessionTimestamp(new Date('2026-07-04T12:00:00'))
    expect(noon).toMatch(/12:00\s*PM/)
  })
})
