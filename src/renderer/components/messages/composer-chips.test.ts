import { describe, expect, it } from 'vitest'
import { formatChipMarker } from '@renderer/lib/chip-marker'
import { chipAt, chipsToAgentText } from './composer-chips'
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
})
