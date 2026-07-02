import { describe, it, expect } from 'vitest'
import { parseSenderPrefix } from './sender-prefix'

describe('parseSenderPrefix', () => {
  it('lifts an escaped "\\[sender]: " prefix into the sender', () => {
    expect(parseSenderPrefix('\\[Dana]: hello')).toEqual({ sender: 'Dana', cleanText: 'hello' })
  })

  it('handles an unescaped "[sender]: " prefix', () => {
    expect(parseSenderPrefix('[Dana]: hi there')).toEqual({ sender: 'Dana', cleanText: 'hi there' })
  })

  it('preserves sender names with spaces', () => {
    expect(parseSenderPrefix('\\[Dana Scully]: hey')).toEqual({ sender: 'Dana Scully', cleanText: 'hey' })
  })

  it('returns a null sender when there is no prefix', () => {
    expect(parseSenderPrefix('just a message')).toEqual({ sender: null, cleanText: 'just a message' })
  })

  it('only strips a leading prefix, not a bracketed span mid-text', () => {
    expect(parseSenderPrefix('see [note]: below')).toEqual({ sender: null, cleanText: 'see [note]: below' })
  })
})
