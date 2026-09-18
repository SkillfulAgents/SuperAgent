import { describe, it, expect } from 'vitest'
import { PROSE_TRAIL, splitUrlTrail } from './url-trail'

describe('splitUrlTrail', () => {
  it('returns the input whole when nothing trails', () => {
    expect(splitUrlTrail('https://example.com/path')).toEqual({ url: 'https://example.com/path', trail: '' })
  })

  it('splits ASCII sentence punctuation', () => {
    expect(splitUrlTrail('https://example.com/path.')).toEqual({ url: 'https://example.com/path', trail: '.' })
  })

  it('splits fullwidth punctuation glued to the URL', () => {
    expect(splitUrlTrail('https://github.com/acme/widget-kit**（public，MIT）。')).toEqual({
      url: 'https://github.com/acme/widget-kit',
      trail: '**（public，MIT）。',
    })
  })

  it('keeps non-punctuation CJK path segments', () => {
    const url = 'https://zh.wikipedia.org/wiki/中文'
    expect(splitUrlTrail(url)).toEqual({ url, trail: '' })
  })

  it('keeps balanced ASCII brackets', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)'
    expect(splitUrlTrail(url)).toEqual({ url, trail: '' })
  })

  it('returns an unbalanced ASCII closing bracket to the prose', () => {
    expect(splitUrlTrail('https://example.com/a(b))')).toEqual({ url: 'https://example.com/a(b)', trail: ')' })
  })

  it('ends the URL at the first fullwidth mark even when brackets balance', () => {
    expect(splitUrlTrail('https://example.com/a（b）')).toEqual({ url: 'https://example.com/a', trail: '（b）' })
  })

  it('keeps fullwidth letters and digits', () => {
    const url = 'https://example.com/ＡＢＣ１２３'
    expect(splitUrlTrail(url)).toEqual({ url, trail: '' })
  })

  it('keeps letters and numerals from the CJK Symbols block (々 〆 〇)', () => {
    for (const url of ['https://example.com/people/佐々木', 'https://example.com/〆切', 'https://example.com/〇一']) {
      expect(splitUrlTrail(url)).toEqual({ url, trail: '' })
    }
  })

  it('still ends at CJK punctuation and fullwidth symbols', () => {
    expect(splitUrlTrail('https://example.com/a、b')).toEqual({ url: 'https://example.com/a', trail: '、b' })
    expect(splitUrlTrail('https://example.com/a～')).toEqual({ url: 'https://example.com/a', trail: '～' })
  })

  it('trims emphasis delimiters only under the markdown trail set', () => {
    expect(splitUrlTrail('https://example.com/auth?token=abc_')).toEqual({ url: 'https://example.com/auth?token=abc', trail: '_' })
    expect(splitUrlTrail('https://example.com/auth?token=abc_', PROSE_TRAIL)).toEqual({ url: 'https://example.com/auth?token=abc_', trail: '' })
    expect(splitUrlTrail('https://example.com/~user*', PROSE_TRAIL)).toEqual({ url: 'https://example.com/~user*', trail: '' })
  })
})
