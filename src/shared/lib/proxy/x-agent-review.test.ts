import { describe, it, expect } from 'vitest'
import { xAgentAlwaysChoices, type XAgentReview } from './x-agent-review'

describe('xAgentAlwaysChoices', () => {
  it.each([
    ['list', [['list', null]]],
    ['read', [['read', 'b'], ['read', null]]],
    ['invoke', [['invoke', 'b'], ['invoke', null], ['read', 'b']]],
    ['create', []],
  ] as const)('a %s card offers exactly its menu', (operation, expected) => {
    const choices = xAgentAlwaysChoices({ operation, targetAgentSlug: operation === 'list' ? '' : 'b' })
    expect(choices.map((c) => [c.operation, c.targetSlug])).toEqual(expected)
  })

  it('a card with files offers the same menu as one without', () => {
    const withFiles: XAgentReview = { operation: 'invoke', targetAgentSlug: 'b', targetAgentName: 'B', fileTransfer: { kind: 'send', paths: ['/workspace/a'] } }
    expect(xAgentAlwaysChoices(withFiles)).toEqual(xAgentAlwaysChoices({ operation: 'invoke', targetAgentSlug: 'b' }))
  })
})
