import { describe, expect, it } from 'vitest'
import { buildConnectionReplacementMessage, parseConnectionReplacementMessage } from './connection-replacement-message'

const previousMessage = '[SYSTEM] Connection to "Slack" was replaced. Previous account ID: old-account. New account ID: new-account. Update scripts, cached account IDs, and proxy URLs that reference the previous account ID.'

describe('connection replacement messages', () => {
  it('recognizes previously persisted account notifications', () => {
    expect(parseConnectionReplacementMessage(previousMessage)).toEqual({
      kind: 'connected-accounts', name: 'Slack', previousId: 'old-account', replacementId: 'new-account',
    })
  })

  it.each(['connected-accounts', 'remote-mcps'] as const)('preserves quoted and Unicode names and IDs for %s', (kind) => {
    const change = { kind, name: 'Team "Analytics" — 東京\\MCP', previousId: 'old-id', replacementId: 'new-id' }
    expect(parseConnectionReplacementMessage(buildConnectionReplacementMessage(change))).toEqual(change)
  })

  it.each([
    previousMessage.replace('[SYSTEM] ', ''),
    '[SYSTEM] Unrelated connection setup notice',
    previousMessage.replace('New account ID:', 'New MCP ID:'),
    previousMessage.replace('new-account', ''),
    previousMessage.replace('"Slack"', '"Invalid\\q"'),
    '[SYSTEM] Connection to "Slack" was replaced.',
  ])('does not misclassify unrelated or malformed text: %s', (text) => {
    expect(parseConnectionReplacementMessage(text)).toBeNull()
  })
})
