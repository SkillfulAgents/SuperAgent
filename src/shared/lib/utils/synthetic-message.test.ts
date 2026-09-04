import { describe, expect, it } from 'vitest'
import { isSyntheticPlaceholderMessage } from './synthetic-message'

describe('isSyntheticPlaceholderMessage', () => {
  it('matches a synthetic assistant placeholder', () => {
    expect(isSyntheticPlaceholderMessage({
      type: 'assistant',
      message: { model: '<synthetic>' },
      isApiErrorMessage: false,
    })).toBe(true)
    expect(isSyntheticPlaceholderMessage({
      type: 'assistant',
      message: { model: '<synthetic>' },
    })).toBe(true)
  })

  it('keeps synthetic API errors, flagged on the JSONL entry or coded on the live frame', () => {
    expect(isSyntheticPlaceholderMessage({
      type: 'assistant',
      message: { model: '<synthetic>' },
      isApiErrorMessage: true,
    })).toBe(false)
    expect(isSyntheticPlaceholderMessage({
      type: 'assistant',
      message: { model: '<synthetic>' },
      error: 'model_not_found',
    })).toBe(false)
  })

  it('ignores real model output and non-assistant entries', () => {
    expect(isSyntheticPlaceholderMessage({ type: 'assistant', message: { model: 'claude-opus-5' } })).toBe(false)
    expect(isSyntheticPlaceholderMessage({ type: 'assistant', message: {} })).toBe(false)
    expect(isSyntheticPlaceholderMessage({ type: 'assistant', message: null })).toBe(false)
    expect(isSyntheticPlaceholderMessage({ type: 'assistant' })).toBe(false)
    expect(isSyntheticPlaceholderMessage({ type: 'user', message: { model: '<synthetic>' } })).toBe(false)
  })
})
