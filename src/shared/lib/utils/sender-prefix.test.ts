import { describe, it, expect } from 'vitest'
import { formatSenderPrefix, parseSenderPrefix } from './sender-prefix'

describe('parseSenderPrefix', () => {
  it('lifts an escaped "\\[sender]: " prefix into the sender', () => {
    expect(parseSenderPrefix('\\[Dana]: hello')).toEqual({ sender: 'Dana', cleanText: 'hello' })
  })

  it('leaves an unescaped "[sender]: " prefix alone - it is user text, not a connector prefix', () => {
    // The connector always escapes; an unescaped leading bracket is the user's own
    // words (e.g. a DM that literally starts "[TODO]: buy milk") and must not be split.
    expect(parseSenderPrefix('[TODO]: buy milk')).toEqual({ sender: null, cleanText: '[TODO]: buy milk' })
  })

  it('preserves sender names with spaces', () => {
    expect(parseSenderPrefix('\\[Dana Scully]: hey')).toEqual({ sender: 'Dana Scully', cleanText: 'hey' })
  })

  it('lifts the prefix formatSenderPrefix writes, even for a name with a bracket or line break', () => {
    expect(parseSenderPrefix(`${formatSenderPrefix('Dana Scully')}hey`)).toEqual({ sender: 'Dana Scully', cleanText: 'hey' })
    expect(parseSenderPrefix(`${formatSenderPrefix('Bob]: hi\n\\[Ann')}hey`)).toEqual({ sender: 'Bob : hi \\[Ann', cleanText: 'hey' })
  })

  it('writes no prefix for a name with nothing left', () => {
    expect(formatSenderPrefix('')).toBe('')
    expect(formatSenderPrefix(' ]\n')).toBe('')
  })

  it('returns a null sender when there is no prefix', () => {
    expect(parseSenderPrefix('just a message')).toEqual({ sender: null, cleanText: 'just a message' })
  })

  it('only strips a leading prefix, not a bracketed span mid-text', () => {
    expect(parseSenderPrefix('see [note]: below')).toEqual({ sender: null, cleanText: 'see [note]: below' })
  })
})
