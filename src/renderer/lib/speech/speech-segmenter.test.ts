import { describe, it, expect } from 'vitest'
import { SpeechSegmenter } from './speech-segmenter'
import type { SpokenWord } from './spoken-words'

function words(text: string, opts: { blockEnd?: boolean } = {}): SpokenWord[] {
  const list = text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, blockEnd: false }))
  if (opts.blockEnd && list.length > 0) list[list.length - 1].blockEnd = true
  return list
}

describe('SpeechSegmenter', () => {
  it('cuts at sentence-ending punctuation', () => {
    const s = new SpeechSegmenter()
    const out = s.push(words('Hello there, friend. How are you? Fine, and you?'))
    expect(out.map((x) => x.text)).toEqual(['Hello there, friend.', 'How are you?', 'Fine, and you?'])
    expect(out.map((x) => [x.wordStart, x.wordEnd])).toEqual([[0, 3], [3, 6], [6, 9]])
  })

  it('cuts at a block end even without punctuation', () => {
    const s = new SpeechSegmenter()
    const out = s.push([...words('Summary', { blockEnd: true }), ...words('first item', { blockEnd: true })])
    expect(out.map((x) => x.text)).toEqual(['Summary', 'first item'])
  })

  it('keeps a too-short "sentence" attached to the next one', () => {
    const s = new SpeechSegmenter()
    // "1." and "Fine!" would otherwise become their own batches
    const out = s.push(words('1. Install it. Fine! Then run it again.'))
    expect(out.map((x) => x.text)).toEqual(['1. Install it.', 'Fine! Then run it again.'])
  })

  it('does not treat abbreviations as sentence ends', () => {
    const s = new SpeechSegmenter()
    const out = s.push(words('Use a tool e.g. grep to search, etc. Ask Dr. Who in the U.S. today. Next one here.'))
    expect(out.map((x) => x.text)).toEqual([
      'Use a tool e.g. grep to search, etc. Ask Dr. Who in the U.S. today.',
      'Next one here.',
    ])
  })

  it('holds a trailing partial sentence until end()', () => {
    const s = new SpeechSegmenter()
    expect(s.push(words('One two three.'))).toHaveLength(1)
    expect(s.push(words('and then some'))).toHaveLength(0)
    const tail = s.end()
    expect(tail).toEqual([{ text: 'and then some', wordStart: 3, wordEnd: 6 }])
    expect(s.end()).toEqual([])
  })

  it('works incrementally: a sentence split across pushes is one segment', () => {
    const s = new SpeechSegmenter()
    expect(s.push(words('The quick brown'))).toHaveLength(0)
    const out = s.push(words('fox jumps.'))
    expect(out).toEqual([{ text: 'The quick brown fox jumps.', wordStart: 0, wordEnd: 5 }])
  })

  it('breaks a long run at a clause boundary past the soft limit', () => {
    const s = new SpeechSegmenter()
    const filler = Array.from({ length: 45 }, (_, i) => `w${i}`).join(' ')
    const out = s.push(words(`${filler}, and then more words here.`))
    expect(out).toHaveLength(2)
    expect(out[0].text.endsWith('w44,')).toBe(true)
    expect(out[0].wordEnd).toBe(45)
    expect(out[1].text).toBe('and then more words here.')
  })

  it('never exceeds the hard limit', () => {
    const s = new SpeechSegmenter()
    const filler = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')
    const out = [...s.push(words(filler)), ...s.end()]
    expect(out.map((x) => x.wordEnd - x.wordStart)).toEqual([80, 20])
  })

  it('accepts closing quotes and brackets after the terminal punctuation', () => {
    const s = new SpeechSegmenter()
    const out = s.push(words('He said "go now." Then he left.'))
    expect(out.map((x) => x.text)).toEqual(['He said "go now."', 'Then he left.'])
  })
})
