import { describe, it, expect } from 'vitest'
import { judgeSelectCommit, parseSelectOptions, targetOptionMatches } from './select-verify'

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

describe('target option list from `get html @ref`', () => {
  // Captured from agent-browser 0.27.2: `get html @e2` on a <select>.
  const cliHtml = '<option value="AL">Alabama</option><option value="CA">California</option><option value="NY" selected="">New York</option>'

  it('parses the CLI output into value/label pairs', () => {
    expect(parseSelectOptions(cliHtml)).toEqual([
      { value: 'AL', label: 'Alabama' },
      { value: 'CA', label: 'California' },
      { value: 'NY', label: 'New York' },
    ])
  })

  it('follows option.label (label attribute over text) and option.value (value attribute over text)', () => {
    // review: <option value="CA" label="California">CA</option> displays California
    expect(parseSelectOptions('<option value="CA" label="California">CA</option><option>Texas</option>')).toEqual([
      { value: 'CA', label: 'California' },
      { value: 'Texas', label: 'Texas' },
    ])
  })

  it('handles attribute order, quoting styles, entities, whitespace and optgroups', () => {
    const html = [
      '<optgroup label="West"><option selected value=\'WA\'>  Washington\n</option>',
      "<option value=OR label='Oregon &amp; Coast'>OR</option></optgroup>",
      '<option value="TX">Texas &#39;n&#39; more</option>',
    ].join('')
    expect(parseSelectOptions(html)).toEqual([
      { value: 'WA', label: 'Washington' },
      { value: 'OR', label: 'Oregon & Coast' },
      { value: 'TX', label: "Texas 'n' more" },
    ])
    expect(parseSelectOptions('')).toEqual([])
    expect(parseSelectOptions('✗ Unknown ref: e31')).toEqual([])
  })

  it('matches only when the TARGET option holding the value carries the requested label', () => {
    const options = parseSelectOptions(cliHtml)
    expect(targetOptionMatches(options, 'California', 'CA')).toBe(true)
    expect(targetOptionMatches(options, ' California ', 'CA')).toBe(true)
    // the reviewer's cases: the target still holds NY — whatever a sibling, a focused or a
    // covering dropdown holds, this target's NY option is "New York", not "California"
    expect(targetOptionMatches(options, 'California', 'NY')).toBe(false)
    expect(targetOptionMatches([], 'California', 'CA')).toBe(false)
  })
})

describe('option-list edge cases from review', () => {
  it('leaves verification unknown when options with the read-back value carry conflicting labels', () => {
    // review: California and New York both value "0" — the value does not say which is selected
    const options = parseSelectOptions('<option value="0">California</option><option value="0" selected>New York</option>')
    expect(targetOptionMatches(options, 'California', '0')).toBe(false)
    expect(targetOptionMatches(options, 'New York', '0')).toBe(false)
    // duplicate values that agree on the label still verify
    expect(targetOptionMatches(parseSelectOptions('<option value="0">Same</option><option value="0">Same</option>'), 'Same', '0')).toBe(true)
  })

  it('ignores option-shaped text that is not a live option: comments, template, script, style', () => {
    const html = [
      '<!-- <option value="CA">California</option> -->',
      '<template><option value="CA">California</option></template>',
      '<script>var s = "<option value=\\"CA\\">California</option>"</script>',
      '<option value="NY" selected>New York</option>',
    ].join('')
    expect(parseSelectOptions(html)).toEqual([{ value: 'NY', label: 'New York' }])
    expect(targetOptionMatches(parseSelectOptions(html), 'California', 'CA')).toBe(false)
  })
})

describe('attribute boundaries', () => {
  it('does not read label= inside another attribute\'s quoted value', () => {
    // review: title="Search label='California'" verified California while the target stayed New York
    const options = parseSelectOptions('<option title="Search label=\'California\'" value="0">New York</option>')
    expect(options).toEqual([{ value: '0', label: 'New York' }])
    expect(targetOptionMatches(options, 'California', '0')).toBe(false)
    expect(parseSelectOptions('<option data-x=\'value="ZZ"\' value="CA">California</option>')).toEqual([{ value: 'CA', label: 'California' }])
  })

  it('tolerates > and = inside quoted values, unquoted values, and repeated attributes (first wins)', () => {
    expect(parseSelectOptions('<option title="a>b=c" value=CA value="XX">California</option>')).toEqual([{ value: 'CA', label: 'California' }])
    expect(parseSelectOptions('<option selected disabled value="">-- pick --</option>')).toEqual([{ value: '', label: '-- pick --' }])
  })

  it('does not treat attribute-looking text content as attributes', () => {
    expect(parseSelectOptions('<option value="0">label=\'X\' value="Y"</option>')).toEqual([{ value: '0', label: "label='X' value=\"Y\"" }])
  })

  it('handles options whose closing tag is omitted, as HTML allows', () => {
    expect(parseSelectOptions('<option value="a">A<option value="b">B<optgroup label="G"><option value="c">C</optgroup>')).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ])
  })
})
