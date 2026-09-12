import { describe, it, expect } from 'vitest'
import { judgeSelectCommit, selectLabelMatchScript, parseLabelMatch } from './select-verify'

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

  it('passes when the requested LABEL names the option that was already selected', () => {
    // mining theme 24: 'requested "California", element value is still "CA"' — CA is California
    expect(judgeSelectCommit('California', 'CA', 'CA', true)).toEqual({ ok: true, committed: 'CA' })
  })

  it('fails when the value reverted (React-controlled select, probe P2)', () => {
    const r = judgeSelectCommit('US', '', '')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('did not change')
      expect(r.reason).toContain('requested "US"')
      expect(r.reason).toContain('Recipe:')
      expect(r.reason).not.toContain('reverted')
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

  it('fails when the value stayed on a different option whose label is not the request', () => {
    const r = judgeSelectCommit('b', 'a', 'a', false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('still "a"')
  })
})

describe('selectLabelMatchScript', () => {
  it('embeds the request and value as JSON so quotes cannot break the script', () => {
    const script = selectLabelMatchScript(' Kids" Menu ', 'k"1')
    expect(script).toContain('"Kids\\" Menu"')
    expect(script).toContain('"k\\"1"')
    expect(script).toContain('querySelectorAll("select")')
  })

  it('parses the CLI double-encoded boolean', () => {
    expect(parseLabelMatch('"true"')).toBe(true)
    expect(parseLabelMatch('true')).toBe(true)
    expect(parseLabelMatch('"false"')).toBe(false)
    expect(parseLabelMatch('garbage')).toBe(false)
  })
})
