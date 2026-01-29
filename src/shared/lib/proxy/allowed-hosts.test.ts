import { describe, it, expect } from 'vitest'
import { isHostAllowed, TOOLKIT_ALLOWED_HOSTS } from './allowed-hosts'

describe('isHostAllowed', () => {
  it('allows known hosts for gmail toolkit', () => {
    expect(isHostAllowed('gmail', 'gmail.googleapis.com')).toBe(true)
    expect(isHostAllowed('gmail', 'www.googleapis.com')).toBe(true)
  })

  it('rejects unknown hosts for gmail toolkit', () => {
    expect(isHostAllowed('gmail', 'evil.com')).toBe(false)
    expect(isHostAllowed('gmail', 'api.github.com')).toBe(false)
  })

  it('allows github api host for github toolkit', () => {
    expect(isHostAllowed('github', 'api.github.com')).toBe(true)
  })

  it('rejects unknown hosts for github toolkit', () => {
    expect(isHostAllowed('github', 'github.com')).toBe(false)
  })

  it('rejects all hosts for unknown toolkit', () => {
    expect(isHostAllowed('unknown_toolkit', 'anything.com')).toBe(false)
  })

  it('handles slack toolkit', () => {
    expect(isHostAllowed('slack', 'slack.com')).toBe(true)
    expect(isHostAllowed('slack', 'api.slack.com')).toBe(false)
  })

  it('handles twitter toolkit with both domains', () => {
    expect(isHostAllowed('twitter', 'api.twitter.com')).toBe(true)
    expect(isHostAllowed('twitter', 'api.x.com')).toBe(true)
    expect(isHostAllowed('twitter', 'twitter.com')).toBe(false)
  })

  it('has entries for all expected toolkits', () => {
    const expectedToolkits = [
      'gmail', 'googlecalendar', 'googledrive', 'slack',
      'github', 'notion', 'linear', 'twitter', 'discord', 'trello',
    ]
    for (const toolkit of expectedToolkits) {
      expect(TOOLKIT_ALLOWED_HOSTS[toolkit]).toBeDefined()
      expect(TOOLKIT_ALLOWED_HOSTS[toolkit].length).toBeGreaterThan(0)
    }
  })
})
