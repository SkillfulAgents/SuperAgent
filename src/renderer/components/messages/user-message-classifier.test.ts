import { describe, expect, it } from 'vitest'
import { classifyUserMessage, classifyUserText } from './user-message-classifier'

describe('classifyUserText', () => {
  it('classifies a system prefix as hidden', () => {
    expect(classifyUserText('[SYSTEM] Hidden setup message')).toEqual({
      kind: 'system',
      hidden: true,
    })
  })

  it('classifies an interrupt marker as visible', () => {
    expect(classifyUserText('[Request interrupted by user]')).toEqual({
      kind: 'interrupt',
      hidden: false,
    })
  })

  it('classifies /compact at the start of trimmed text', () => {
    expect(classifyUserText('/compact')).toEqual({ kind: 'compact', hidden: false })
    expect(classifyUserText('  /compact  ')).toEqual({ kind: 'compact', hidden: false })
    expect(classifyUserText('/compact now')).toEqual({ kind: 'compact', hidden: false })
  })

  it('does not treat /compaction as compact', () => {
    expect(classifyUserText('/compaction')).toEqual({ kind: 'plain', hidden: false })
  })

  it('falls back to plain', () => {
    expect(classifyUserText('hello')).toEqual({ kind: 'plain', hidden: false })
  })

  it('does not trim before the system and interrupt prefixes', () => {
    expect(classifyUserText(' [SYSTEM] x')).toEqual({ kind: 'plain', hidden: false })
    expect(classifyUserText('[SYSTEM]x')).toEqual({ kind: 'plain', hidden: false })
    expect(classifyUserText(' [Request interrupted by user]')).toEqual({ kind: 'plain', hidden: false })
  })
})

describe('classifyUserMessage', () => {
  it('classifies a user message from its text', () => {
    expect(classifyUserMessage({
      type: 'user',
      content: { text: '[SYSTEM] Hidden setup message' },
    })).toEqual({ kind: 'system', hidden: true })
  })

  it('returns plain for a non-user message', () => {
    expect(classifyUserMessage({
      type: 'assistant',
      content: { text: '[SYSTEM] Hidden setup message' },
    })).toEqual({ kind: 'plain', hidden: false })
  })

  it('returns plain when content is a string', () => {
    expect(classifyUserMessage({
      type: 'user',
      content: '[Request interrupted by user]',
    })).toEqual({ kind: 'plain', hidden: false })
  })

  it('returns plain for missing, null, or empty-object content', () => {
    expect(classifyUserMessage({ type: 'user' })).toEqual({ kind: 'plain', hidden: false })
    expect(classifyUserMessage({ type: 'user', content: null })).toEqual({ kind: 'plain', hidden: false })
    expect(classifyUserMessage({ type: 'user', content: {} })).toEqual({ kind: 'plain', hidden: false })
  })
})
