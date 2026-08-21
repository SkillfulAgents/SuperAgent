import { describe, it, expect } from 'vitest'
import { judgeSelectCommit } from './select-verify'

describe('judgeSelectCommit', () => {
  it('passes when the value committed exactly (select by value)', () => {
    expect(judgeSelectCommit('us', '', 'us')).toEqual({ ok: true, committed: 'us' })
  })

  it('passes when the value changed to a different string (select by visible label)', () => {
    // selecting "United States" (label) commits the option value "us"
    const r = judgeSelectCommit('United States', '', 'us')
    expect(r).toEqual({ ok: true, committed: 'us' })
  })

  it('passes when the requested value was already selected (no-op commit)', () => {
    expect(judgeSelectCommit('us', 'us', 'us')).toEqual({ ok: true, committed: 'us' })
  })

  it('fails when the value reverted (React-controlled select, probe P2)', () => {
    const r = judgeSelectCommit('US', '', '')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('did not commit')
      expect(r.reason).toContain('requested "US"')
      expect(r.reason).toContain('Recipe:')
    }
  })

  it('fails when the target has no readable value (custom dropdown div)', () => {
    const r = judgeSelectCommit('AI Tools', null, null)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('not a native <select>')
      expect(r.reason).toContain('Recipe:')
    }
  })

  it('fails when the value stayed on a different option', () => {
    const r = judgeSelectCommit('b', 'a', 'a')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('still "a"')
  })
})
