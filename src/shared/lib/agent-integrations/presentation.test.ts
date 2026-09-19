import { describe, it, expect } from 'vitest'
import { formatProviderName, isSettling } from './presentation'

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
