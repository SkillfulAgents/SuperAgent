import { describe, it, expect } from 'vitest'
import { splitChatMessage } from './utils'

// Default to Slack's 3000-char limit for these tests
const splitSlackMessage = (text: string, maxLength = 3000) => splitChatMessage(text, maxLength)

describe('splitChatMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitSlackMessage('hello world')
    expect(result).toEqual(['hello world'])
  })

  it('returns single chunk for exactly max-length messages', () => {
    const text = 'a'.repeat(3000)
    const result = splitSlackMessage(text)
    expect(result).toEqual([text])
  })

  it('splits at paragraph boundary (double newline)', () => {
    const para1 = 'a'.repeat(2000)
    const para2 = 'b'.repeat(2000)
    const text = `${para1}\n\n${para2}`

    const result = splitSlackMessage(text)
    expect(result).toEqual([para1, para2])
  })

  it('splits at line boundary when no paragraph break is available', () => {
    const line1 = 'a'.repeat(2000)
    const line2 = 'b'.repeat(2000)
    const text = `${line1}\n${line2}`

    const result = splitSlackMessage(text)
    expect(result).toEqual([line1, line2])
  })

  it('hard-splits when no newline is available', () => {
    const text = 'a'.repeat(6000)
    const result = splitSlackMessage(text)

    expect(result).toHaveLength(2)
    expect(result[0]).toBe('a'.repeat(3000))
    expect(result[1]).toBe('a'.repeat(3000))
  })

  it('trims leading whitespace from subsequent chunks', () => {
    const para1 = 'a'.repeat(2000)
    const para2 = 'b'.repeat(2000)
    const text = `${para1}\n\n   ${para2}`

    const result = splitSlackMessage(text)
    expect(result).toEqual([para1, para2])
  })

  it('handles three chunks', () => {
    const para1 = 'a'.repeat(2500)
    const para2 = 'b'.repeat(2500)
    const para3 = 'c'.repeat(2500)
    const text = `${para1}\n\n${para2}\n\n${para3}`

    const result = splitSlackMessage(text)
    expect(result).toHaveLength(3)
    expect(result[0]).toBe(para1)
    expect(result[1]).toBe(para2)
    expect(result[2]).toBe(para3)
  })

  it('avoids splitting too early (boundary must be past halfway)', () => {
    // Paragraph break at position 100 (too early, less than 3000/2=1500)
    // Line break at position 2800 (good)
    const earlyPara = 'a'.repeat(100)
    const midSection = 'b'.repeat(2699) // 100 + 2 (\n\n) + 2699 = 2801, then \n at 2801
    const lineBreakSection = 'c'.repeat(198) // 2801 + 1 (\n) + 198 = 3000
    const overflow = 'd'.repeat(500)
    const text = `${earlyPara}\n\n${midSection}\n${lineBreakSection}\n${overflow}`

    const result = splitSlackMessage(text)
    // Should NOT split at the early paragraph break (pos 100)
    // Should split at the line break near position 2801
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result[0].length).toBeGreaterThan(1500)
    expect(result[0].length).toBeLessThanOrEqual(3000)
  })

  it('returns empty string chunk for empty input', () => {
    const result = splitSlackMessage('')
    expect(result).toEqual([''])
  })

  it('respects custom maxLength parameter', () => {
    const text = 'a'.repeat(20)
    const result = splitSlackMessage(text, 10)
    expect(result).toEqual(['a'.repeat(10), 'a'.repeat(10)])
  })
})
