import { describe, it, expect } from 'vitest'
import {
  formatMention, parseMentions, resolveMentions, flattenMentions,
  appendMentionContext, stripMentionContext, mentionsToMarkdownLinks,
  applyCanonicalMentionNames,
} from './mentions'

describe('mentions', () => {
  it('round-trips a marker', () => {
    const text = `hi ${formatMention({ userId: 'u1', name: 'Iddo Gino' })} look`
    expect(parseMentions(text)).toEqual([{ userId: 'u1', name: 'Iddo Gino' }])
  })

  it('ignores an escaped marker typed by hand', () => {
    expect(parseMentions('\\[\\[mention:u1|Iddo]]')).toEqual([])
  })

  it('encodes delimiter characters in names', () => {
    const text = formatMention({ userId: 'u1', name: 'A|B]C' })
    expect(text).toBe('[[mention:u1|A%7CB%5DC]]')
    expect(parseMentions(text)).toEqual([{ userId: 'u1', name: 'A|B]C' }])
    expect(flattenMentions(text)).toBe('@A|B]C')
  })

  it('rejects ids outside the grammar', () => {
    expect(parseMentions('[[mention:not valid|X]]')).toEqual([])
  })

  it('resolveMentions drops self, collapses duplicates, reports unknown ids', () => {
    const acl = new Set(['me', 'u1'])
    expect(resolveMentions([{ userId: 'u1', name: 'A' }, { userId: 'u1', name: 'A' }, { userId: 'me', name: 'Me' }], acl, 'me'))
      .toEqual({ ok: true, recipients: [{ userId: 'u1', name: 'A' }] })
    expect(resolveMentions([{ userId: 'u9', name: 'Z' }], acl, 'me')).toEqual({ ok: false, unknown: ['u9'] })
  })

  it('appends one context line and strips it back', () => {
    const withCtx = appendMentionContext('x [[mention:u1|A]]', 'Graham')
    expect(withCtx).toMatch(/\n\n\[\[mention-context: Graham tagged a teammate/)
    expect(stripMentionContext(withCtx)).toBe('x [[mention:u1|A]]')
  })

  it('strips a context line when the sender name contains ]', () => {
    const withCtx = appendMentionContext('x [[mention:u1|A]]', 'A]B')
    expect(stripMentionContext(withCtx)).toBe('x [[mention:u1|A]]')
  })

  it('rewrites marker names from the membership roster', () => {
    const text = `hi ${formatMention({ userId: 'u1', name: 'Fake' })}`
    expect(applyCanonicalMentionNames(text, new Map([['u1', 'Iddo Gino']])))
      .toBe(`hi ${formatMention({ userId: 'u1', name: 'Iddo Gino' })}`)
  })

  it('flattens for notification bodies and converts to markdown links for rendering', () => {
    const t = appendMentionContext('ping [[mention:u1|Iddo Gino]] now', 'G')
    expect(flattenMentions(t)).toBe('ping @Iddo Gino now')
    expect(mentionsToMarkdownLinks(stripMentionContext(t))).toBe('ping [@Iddo Gino](mention:u1) now')
  })

  it('escapes ] in markdown mention labels', () => {
    const text = formatMention({ userId: 'u1', name: 'A]B' })
    expect(mentionsToMarkdownLinks(text)).toBe('[@A\\]B](mention:u1)')
  })
})
