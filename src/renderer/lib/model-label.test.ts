import { describe, it, expect } from 'vitest'
import { formatModelId, formatModelSlug } from './model-label'

describe('formatModelSlug', () => {
  it('title-cases words, upper-cases short ones, and dots adjacent version parts', () => {
    expect(formatModelSlug('haiku-4-5')).toBe('Haiku 4.5')
    expect(formatModelSlug('sonnet-5')).toBe('Sonnet 5')
    expect(formatModelSlug('gpt-5')).toBe('GPT 5')
  })
})

describe('formatModelId', () => {
  it('drops the claude- prefix and a trailing date stamp', () => {
    expect(formatModelId('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModelId('claude-fable-5-1')).toBe('Fable 5.1')
    expect(formatModelId('claude-opus-4-6')).toBe('Opus 4.6')
  })

  it('passes a bare slug (meta.json form) through unchanged in meaning', () => {
    expect(formatModelId('haiku-4-5')).toBe('Haiku 4.5')
  })
})
