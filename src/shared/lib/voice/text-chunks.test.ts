import { describe, expect, it } from 'vitest'
import { splitSpeechText } from './text-chunks'
describe('speech input chunking', () => {
  it.each(['utf8', 'utf16'] as const)('preserves exact Unicode text within %s bounds', unit => {
    const text = '你好🌍 hello\nworld '.repeat(1200)
    const chunks = splitSpeechText(text, 400, unit, true)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => (unit === 'utf8' ? new TextEncoder().encode(chunk).length : chunk.length) <= 400)).toBe(true)
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true)
  })
  it('prefers word boundaries but hard-splits oversized words', () => {
    expect(splitSpeechText('hello world abcdefghijk', 10, 'utf16', true)).toEqual(['hello ', 'world ', 'abcdefghij', 'k'])
  })
})
