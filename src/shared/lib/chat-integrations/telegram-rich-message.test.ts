import { describe, it, expect } from 'vitest'
import { inputRichMessageSchema } from './telegram-rich-message-schema'
import { telegramConfigSchema } from './config-schema'
import {
  markdownToRichMessage,
  splitForRichLimits,
  THINKING_RICH_MESSAGE,
  RICH_MAX_LENGTH,
} from './telegram-rich-message'

describe('inputRichMessageSchema', () => {
  it('accepts a markdown-only message', () => {
    const r = inputRichMessageSchema.parse({ markdown: '# Hi' })
    expect(r.markdown).toBe('# Hi')
  })

  it('accepts an html-only message', () => {
    expect(() => inputRichMessageSchema.parse({ html: '<b>x</b>' })).not.toThrow()
  })

  it('rejects when both html and markdown are present', () => {
    expect(() => inputRichMessageSchema.parse({ html: '<b>x</b>', markdown: 'x' })).toThrow()
  })

  it('rejects when neither html nor markdown is present', () => {
    expect(() => inputRichMessageSchema.parse({ is_rtl: true })).toThrow()
  })

  it('carries optional flags', () => {
    const r = inputRichMessageSchema.parse({ markdown: 'x', skip_entity_detection: true })
    expect(r.skip_entity_detection).toBe(true)
  })
})

describe('markdownToRichMessage', () => {
  it('passes GFM markdown through untouched in the markdown field', () => {
    const md = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(markdownToRichMessage(md)).toEqual({ markdown: md })
  })

  it('omits skip_entity_detection by default (auto-detection ON)', () => {
    expect(markdownToRichMessage('hi').skip_entity_detection).toBeUndefined()
  })

  it('sets skip_entity_detection when requested', () => {
    expect(markdownToRichMessage('hi', { skipEntityDetection: true }).skip_entity_detection).toBe(true)
  })
})

describe('splitForRichLimits', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitForRichLimits('short')).toEqual(['short'])
  })

  it('splits a body over the 32768 ceiling', () => {
    const big = 'para\n\n'.repeat(7000) // > 32768 chars
    const chunks = splitForRichLimits(big)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= RICH_MAX_LENGTH)).toBe(true)
  })
})

describe('THINKING_RICH_MESSAGE', () => {
  it('is a draft-only tg-thinking placeholder with no reasoning content', () => {
    expect(THINKING_RICH_MESSAGE.html).toContain('<tg-thinking')
    expect(THINKING_RICH_MESSAGE.markdown).toBeUndefined()
  })
})

describe('telegramConfigSchema rich flags', () => {
  it('accepts the rich flags', () => {
    const r = telegramConfigSchema.parse({
      botToken: 't',
      richMessages: false,
      draftStreaming: false,
      skipEntityDetection: true,
    })
    expect(r.richMessages).toBe(false)
    expect(r.draftStreaming).toBe(false)
    expect(r.skipEntityDetection).toBe(true)
  })

  it('leaves the flags undefined when omitted (defaults applied in connector)', () => {
    const r = telegramConfigSchema.parse({ botToken: 't' })
    expect(r.richMessages).toBeUndefined()
  })
})
