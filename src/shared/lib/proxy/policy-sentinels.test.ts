import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_DEFAULT_SCOPE,
  labelDefaultKey,
  isLabelDefaultKey,
  LABEL_DEFAULT_BASELINE,
} from './policy-sentinels'
import type { ScopeLabel } from './scope-metadata'

describe('policy-sentinels', () => {
  it('labelDefaultKey prefixes the label with "*"', () => {
    expect(labelDefaultKey('read')).toBe('*read')
    expect(labelDefaultKey('write')).toBe('*write')
    expect(labelDefaultKey('destructive')).toBe('*destructive')
  })

  it('isLabelDefaultKey recognizes only the three label sentinels', () => {
    expect(isLabelDefaultKey('*read')).toBe(true)
    expect(isLabelDefaultKey('*write')).toBe(true)
    expect(isLabelDefaultKey('*destructive')).toBe(true)
    // account-wide default and real scopes are NOT label sentinels
    expect(isLabelDefaultKey(ACCOUNT_DEFAULT_SCOPE)).toBe(false)
    expect(isLabelDefaultKey('gmail.send')).toBe(false)
    expect(isLabelDefaultKey('data.records:read')).toBe(false)
    expect(isLabelDefaultKey('readonly')).toBe(false)
  })

  it('baseline is read=allow / write=review / destructive=block', () => {
    expect(LABEL_DEFAULT_BASELINE).toEqual({
      read: 'allow',
      write: 'review',
      destructive: 'block',
    })
  })

  it('key ∘ slice(1) round-trips (the pill relies on slice(1) === label)', () => {
    for (const label of ['read', 'write', 'destructive'] as ScopeLabel[]) {
      const key = labelDefaultKey(label)
      expect(isLabelDefaultKey(key)).toBe(true)
      expect(key.slice(1)).toBe(label)
    }
  })
})
