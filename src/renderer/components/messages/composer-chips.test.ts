import { describe, expect, it } from 'vitest'
import { formatChipMarker } from '@renderer/lib/chip-marker'
import { chipAt, chipsToAgentText, draftFromAgentText, openingTeammate, type ChipContext } from './composer-chips'
import { secretMarker } from './secret-chip'

const saved = (...envVars: string[]) => ({ secretEnvVars: new Set(envVars) })

describe('composer chips', () => {
  it('reads back the chip a marker was formatted from', () => {
    const marker = secretMarker({ envVar: 'GITHUB_TOKEN', key: 'GitHub Token | prod]' })
    expect(chipAt(marker)).toEqual({
      chip: { kind: 'secret', referent: 'GITHUB_TOKEN', label: 'GitHub Token | prod]' },
      length: marker.length,
    })
  })

  it('reads a marker at an offset and nothing before it', () => {
    const text = `See ${secretMarker({ envVar: 'K', key: 'Name' })}`
    expect(chipAt(text)).toBeNull()
    expect(chipAt(text, 4)?.chip.referent).toBe('K')
  })

  it('replaces a lone surrogate in the label instead of throwing', () => {
    const marker = formatChipMarker({ kind: 'secret', referent: 'K', label: '\uD83D' })
    expect(chipAt(marker)?.chip.label).toBe('�')
  })

  it.each([
    ['an unregistered kind', '[[foo:bar|baz]]'],
    ['a label that does not decode', '[[secret:X|%E0]]'],
    ['a secret referent that is not an env var', '[[secret:lower|x]]'],
    ['whitespace in the referent', '[[secret:FOO\nBAR|x]]'],
  ])('leaves %s as text', (_, marker) => {
    expect(chipAt(marker)).toBeNull()
    expect(chipsToAgentText(marker, saved('X', 'lower', 'FOO\nBAR'))).toBe(marker)
  })

  it('swaps every saved secret for its .env placeholder on send', () => {
    const secret = secretMarker({ envVar: 'GITHUB_TOKEN', key: 'GitHub Token' })
    expect(chipsToAgentText(`${secret} and ${secret}`, saved('GITHUB_TOKEN'))).toBe(
      '[Key saved to .env - GITHUB_TOKEN] and [Key saved to .env - GITHUB_TOKEN]'
    )
  })

  it('sends a secret the agent does not have as its marker', () => {
    const secret = secretMarker({ envVar: 'MISSING', key: 'Nope' })
    expect(chipsToAgentText(secret, saved('OTHER'))).toBe(secret)
  })

  it('treats every secret as saved until the list loads', () => {
    expect(chipsToAgentText(secretMarker({ envVar: 'K', key: 'Name' }), {})).toBe('[Key saved to .env - K]')
  })

  describe('mentions', () => {
    const mike = formatChipMarker({ kind: 'user', referent: 'mike-id', label: 'Mike Smith' })
    const billing = formatChipMarker({ kind: 'agent', referent: 'k3j4h5g6f7', label: 'Billing Agent' })
    const context: ChipContext = {
      members: new Map([['mike-id', { id: 'mike-id', name: 'Mike Smith', email: 'mike@acme.com' }]]),
      agents: new Map([['k3j4h5g6f7', { slug: 'k3j4h5g6f7', displaySlug: 'billing-agent-k3j4h5g6f7', name: 'Billing Agent' }]]),
    }

    it('sends each mention as its name, listed once after the message', () => {
      expect(chipsToAgentText(`${mike} and ${billing}, then ${mike} again`, context)).toBe(
        '@Mike Smith and @Billing Agent, then @Mike Smith again\n\n[Mentioned:]\n'
        + '- @Mike Smith: teammate, mike@acme.com (user id mike-id)\n'
        + '- @Billing Agent: agent, slug billing-agent-k3j4h5g6f7 (call it by this slug with the agents tools, no need to list agents first)',
      )
    })

    it('says when a message only notified the teammates it tags', () => {
      expect(chipsToAgentText(`${mike} look`, context, { silent: true })).toMatch(/\(This message only notifies the teammates it tags/)
    })

    it('lists a teammate without an email until the roster has one', () => {
      expect(chipsToAgentText(mike, {})).toContain('- @Mike Smith: teammate (user id mike-id)')
    })

    it('sends a mention of a deleted agent as its marker, unlisted', () => {
      expect(chipsToAgentText(`ask ${billing}`, { agents: new Map() })).toBe(`ask ${billing}`)
    })

    it('knows the teammate a draft opens on', () => {
      expect(openingTeammate(`  ${mike} look`)).toEqual({ kind: 'user', referent: 'mike-id', label: 'Mike Smith' })
      expect(openingTeammate(`look ${mike}`)).toBeNull()
      expect(openingTeammate(`${billing} look`)).toBeNull()
    })

    it('turns a sent message back into the draft it was sent from', () => {
      const agentId = (slug: string) => (slug === 'billing-agent-k3j4h5g6f7' ? 'k3j4h5g6f7' : slug)
      const draft = `${mike} and ${billing}, then ${mike} again`
      expect(draftFromAgentText(chipsToAgentText(draft, context), agentId)).toBe(draft)
      expect(draftFromAgentText(chipsToAgentText(`${mike} look`, context, { silent: true }), agentId)).toBe(`${mike} look`)
      expect(draftFromAgentText('no mentions here', agentId)).toBe('no mentions here')
    })

    it('reads the longer of two names that share a start', () => {
      const ann = formatChipMarker({ kind: 'user', referent: 'ann-id', label: 'Ann' })
      const annLee = formatChipMarker({ kind: 'user', referent: 'ann-lee-id', label: 'Ann Lee' })
      const draft = `${ann} and ${annLee}`
      expect(draftFromAgentText(chipsToAgentText(draft, {}), (slug) => slug)).toBe(draft)
    })
  })
})
