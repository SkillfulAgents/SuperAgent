import { describe, it, expect } from 'vitest'
import {
  judgeSelectCommit,
  parseElementBox,
  selectTargetStateScript,
  parseSelectTargetState,
  targetMatches,
} from './select-verify'

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

  it('passes when the requested LABEL names the option the target already holds', () => {
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

  it('reports an unreadable value as unverified, without diagnosing the element', () => {
    const r = judgeSelectCommit('AI Tools', null, null)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('could not be read back')
      expect(r.reason).toContain('unverified')
      expect(r.reason).not.toContain('so it is not a native')
      expect(r.reason).not.toContain('probably')
      expect(r.reason).toContain('Recipe:')
    }
  })

  it('fails when the value stayed on a different option whose label is not the request', () => {
    const r = judgeSelectCommit('b', 'a', 'a', false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('still "a"')
  })
})

describe('target identification by rectangle', () => {
  it('parses the CLI box JSON envelope and a bare box', () => {
    expect(parseElementBox('{"success":true,"data":{"height":19,"width":85,"x":55,"y":81.875},"error":null}')).toEqual({ x: 55, y: 81.875, width: 85, height: 19 })
    expect(parseElementBox('{"x":1,"y":2,"width":3,"height":4}')).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(parseElementBox('{"success":false,"data":null}')).toBeNull()
    expect(parseElementBox('x:      55')).toBeNull()
  })

  it('reads the <select> AT the box, checks its rectangle, and never consults focus or searches the page', () => {
    const script = selectTargetStateScript({ x: 55, y: 81.875, width: 85, height: 19 })
    expect(script).toContain('document.elementFromPoint')
    expect(script).toContain('getBoundingClientRect')
    expect(script).toContain('tagName!=="SELECT"')
    expect(script).not.toContain('activeElement')
    expect(script).not.toContain('querySelectorAll')
    // review: <option value="CA" label="California">CA</option> displays California — option.label, not .text
    expect(script).toContain('o.label||o.text')
    // both viewport- and document-relative interpretations of the CLI box are tried
    expect(script).toContain('window.scrollX')
  })

  it('parses the CLI double-encoded state and rejects anything else', () => {
    expect(parseSelectTargetState(JSON.stringify(JSON.stringify({ value: 'CA', label: 'California' })))).toEqual({ value: 'CA', label: 'California' })
    expect(parseSelectTargetState('{"value":"CA","label":"California"}')).toEqual({ value: 'CA', label: 'California' })
    expect(parseSelectTargetState('null')).toBeNull()
    expect(parseSelectTargetState('"null"')).toBeNull()
    expect(parseSelectTargetState('garbage')).toBeNull()
  })

  it('matches only when the TARGET holds the value under the requested label', () => {
    expect(targetMatches({ value: 'CA', label: 'California' }, 'California', 'CA')).toBe(true)
    expect(targetMatches({ value: 'CA', label: 'California' }, ' California ', 'CA')).toBe(true)
    // the reviewer's case: target reverted to New York while another dropdown holds California
    expect(targetMatches({ value: 'NY', label: 'New York' }, 'California', 'NY')).toBe(false)
    // no <select> with the target's rectangle at that point: unknown, so no match
    expect(targetMatches(null, 'California', 'CA')).toBe(false)
  })
})
