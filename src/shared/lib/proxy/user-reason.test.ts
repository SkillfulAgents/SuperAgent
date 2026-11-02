import { describe, expect, it } from 'vitest'
import { cleanUserReason } from './user-reason'

describe('cleanUserReason', () => {
  it('trims, drops blank or non-text input, and caps the length', () => {
    expect(cleanUserReason('  Use the shared folder  ')).toBe('Use the shared folder')
    expect(cleanUserReason('   ')).toBeUndefined()
    expect(cleanUserReason(42)).toBeUndefined()
    expect(cleanUserReason('x'.repeat(600))).toHaveLength(500)
  })
})
