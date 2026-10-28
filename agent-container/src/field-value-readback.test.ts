import { describe, it, expect } from 'vitest'
import { resolveCommittedValue, type FieldRead } from './field-value-readback'

const read = (text: string): FieldRead => ({ ok: true, text })
const failed: FieldRead = { ok: false, text: '' }

describe('resolveCommittedValue', () => {
  it('uses the form-control value when it is non-empty (input/textarea)', () => {
    // The common case: `get value` returns the value, no text fallback needed.
    expect(resolveCommittedValue(read('hello'), null)).toBe('hello')
  })

  it('does not consult text when value is non-empty', () => {
    // Even if a (hypothetical) text read would differ, value wins.
    expect(resolveCommittedValue(read('hello'), read('ignored'))).toBe('hello')
  })

  it('falls back to text content for contenteditable when value is empty', () => {
    // LinkedIn's message box: `get value` is "" but `get text` has the content.
    // Returning "" here is exactly what drove agents to re-type "hellohello".
    expect(resolveCommittedValue(read(''), read('hello'))).toBe('hello')
  })

  it('falls back to text when the value read failed but text succeeded', () => {
    expect(resolveCommittedValue(failed, read('hello'))).toBe('hello')
  })

  it('reports "" for a genuinely empty form control', () => {
    expect(resolveCommittedValue(read(''), read(''))).toBe('')
  })

  it('reports "" when value read failed but text read returned empty', () => {
    expect(resolveCommittedValue(failed, read(''))).toBe('')
  })

  it('returns null when nothing could be read back', () => {
    expect(resolveCommittedValue(failed, failed)).toBeNull()
  })

  it('returns null when value is empty/unreadable and no text read was done', () => {
    // Defensive: caller should perform the text read on an empty value, but if
    // it passes null we cannot claim the field is empty without evidence.
    expect(resolveCommittedValue(failed, null)).toBeNull()
  })
})
