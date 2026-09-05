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
    const known = new Set(['GITHUB_TOKEN'])

    expect(rewriteChipsForSend(`${secret} ${other} ${secret}`, known)).toBe(
      '[Key saved to .env - GITHUB_TOKEN] [[foo:bar|baz]] [Key saved to .env - GITHUB_TOKEN]'
    )
  })

  it('leaves a secret marker alone when the agent does not have that key', () => {
    const secret = formatChipMarker('secret', 'MISSING', 'Nope')
    expect(rewriteChipsForSend(secret, new Set())).toBe(secret)
  })

  it('replaces a lone surrogate in the label instead of throwing', () => {
    const lone = '\uD83D'
    expect(() => formatChipMarker('secret', 'K', lone)).not.toThrow()
    expect(parseChipMarker(formatChipMarker('secret', 'K', lone))).toEqual({
      kind: 'secret',
      referent: 'K',
      label: lone.toWellFormed(),
    })
  })

  it('parses only a whole marker', () => {
    const marker = formatChipMarker('secret', 'K', 'Name')
    expect(parseChipMarker(`See ${marker}`)).toBeNull()
  })

  it('leaves a marker with a malformed label as text', () => {
    const raw = '[[secret:X|%E0]]'
    expect(parseChipMarker(raw)).toBeNull()
    expect(rewriteChipsForSend(raw, new Set(['X']))).toBe(raw)
  })

  it('refuses a secret marker whose name is not an env var', () => {
    const raw = '[[secret:FOO\nBAR|x]]'
    expect(secretChip.composer.parse(raw)).toBeNull()
    expect(rewriteChipsForSend(raw, new Set(['FOO\nBAR']))).toBe(raw)
  })

  it('accepts an ordinary key name that contains a digit', () => {
    const chip = {
      kind: 'secret' as const,
      payload: { key: 'my_openai_key_2024_prod', envVar: 'OPENAI_KEY' },
    }
    expect(secretChip.composer.parse(secretChip.composer.raw(chip))).toEqual(chip)
    expect(rewriteChipsForSend(secretChip.composer.raw(chip), new Set(['OPENAI_KEY']))).toBe(
      '[Key saved to .env - OPENAI_KEY]'
    )
  })

  it('refuses a secret marker whose label is a raw credential', () => {
    const key = ['sk-', 'proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'].join('')
    const raw = `[[secret:A|${key}]]`
    expect(secretChip.composer.parse(raw)).toBeNull()
    expect(rewriteChipsForSend(raw, new Set(['A']))).toBe(raw)
  })
})
