import { describe, expect, it } from 'vitest'
import { formatChipMarker, parseChipMarker } from './chip-marker'
import { rewriteChipsForSend } from './composer-chips'
import { secretChip } from './secret-chip'

describe('composer chips', () => {
  it('round-trips a secret through composer.raw and composer.parse', () => {
    const chip = {
      kind: 'secret' as const,
      payload: { key: 'GitHub Token', envVar: 'GITHUB_TOKEN' },
    }

    expect(secretChip.composer.parse(secretChip.composer.raw(chip))).toEqual(chip)
  })

  it('rewrites every secret marker on send and leaves unknown markers alone', () => {
    const secret = formatChipMarker('secret', 'GITHUB_TOKEN', 'GitHub Token')
    const other = formatChipMarker('foo', 'bar', 'baz')

    expect(rewriteChipsForSend(`${secret} ${other} ${secret}`)).toBe(
      '[Key saved to .env - GITHUB_TOKEN] [[foo:bar|baz]] [Key saved to .env - GITHUB_TOKEN]'
    )
  })

  it('leaves a marker with a malformed label as text', () => {
    const raw = '[[secret:X|%E0]]'
    expect(parseChipMarker(raw)).toBeNull()
    expect(rewriteChipsForSend(raw)).toBe(raw)
  })
})
