import { describe, it, expect } from 'vitest'
import { splitUrlTrail } from './url-trail'

describe('splitUrlTrail', () => {
  it('returns the input whole when nothing trails', () => {
    expect(splitUrlTrail('https://example.com/path')).toEqual({ url: 'https://example.com/path', trail: '' })
  })

  it('splits ASCII sentence punctuation', () => {
    expect(splitUrlTrail('https://example.com/path.')).toEqual({ url: 'https://example.com/path', trail: '.' })
  })

  it('splits fullwidth punctuation glued to the URL', () => {
    expect(splitUrlTrail('https://github.com/acme/widget-kit**（公开，MIT）。')).toEqual({
      url: 'https://github.com/acme/widget-kit',
      trail: '**（公开，MIT）。',
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
})
