import { describe, it, expect } from 'vitest'
import { classifyWaitTarget, formatWaitResult } from './wait-target'

describe('classifyWaitTarget', () => {
  it('passes a CSS selector to the CLI unchanged', () => {
    expect(classifyWaitTarget('#results .row')).toEqual({ kind: 'selector', args: ['wait', '#results .row'] })
  })

  it('treats a bare number as milliseconds (the CLI sleeps)', () => {
    expect(classifyWaitTarget('2000')).toEqual({ kind: 'ms', ms: 2000, args: ['wait', '2000'] })
  })

  it('maps load states to --load', () => {
    expect(classifyWaitTarget('networkidle')).toEqual({ kind: 'load', state: 'networkidle', args: ['wait', '--load', 'networkidle'] })
  })

  it('refuses Playwright locator prefixes and names the --text / --url modes', () => {
    const r = classifyWaitTarget('text=Trigger')
    expect(r.kind).toBe('rejected')
    if (r.kind === 'rejected') {
      expect(r.reason).toContain('not a CSS selector')
      expect(r.reason).toContain('["wait","--text","<text>"]')
      expect(r.reason).toContain('["wait","--url","<pattern>"]')
    }
    expect(classifyWaitTarget('role=button').kind).toBe('rejected')
  })

  it('refuses Playwright-only pseudo selectors', () => {
    expect(classifyWaitTarget('button:has-text("Save")').kind).toBe('rejected')
    expect(classifyWaitTarget('div >> text=Hi').kind).toBe('rejected')
  })

  it('does not refuse valid CSS that merely contains an equals sign', () => {
    expect(classifyWaitTarget('input[name=email]').kind).toBe('selector')
    expect(classifyWaitTarget('[data-testid="save"]').kind).toBe('selector')
  })
})

describe('formatWaitResult', () => {
  it('states the elapsed time for a selector, so a 0 ms match is visible as one', () => {
    expect(formatWaitResult(classifyWaitTarget('body'), 3, false)).toBe('Selector "body" matched after 3 ms.')
    expect(formatWaitResult(classifyWaitTarget('.loaded'), 1840, false)).toBe('Selector ".loaded" matched after 1840 ms.')
  })

  it('reports a sleep as a sleep', () => {
    expect(formatWaitResult(classifyWaitTarget('1500'), 1503, false)).toBe('Waited 1503 ms.')
  })

  it('never reports a timed-out load state as reached', () => {
    expect(formatWaitResult(classifyWaitTarget('networkidle'), 25010, true)).toBe('Load state "networkidle" was not reached within 25010 ms.')
    expect(formatWaitResult(classifyWaitTarget('load'), 120, false)).toBe('Load state "load" reached after 120 ms.')
  })
})

describe('classifyWaitTarget respects quoted strings', () => {
  it('accepts valid CSS whose quoted value contains Playwright-looking text', () => {
    // review: button[data-note="a>>b"] works in the pinned CLI
    expect(classifyWaitTarget('button[data-note="a>>b"]').kind).toBe('selector')
    expect(classifyWaitTarget("[title=':has-text(x)']").kind).toBe('selector')
    expect(classifyWaitTarget('[data-x="say \\"hi\\" >> there"]').kind).toBe('selector')
  })

  it('still refuses Playwright syntax outside quotes', () => {
    expect(classifyWaitTarget('div >> text=Hi').kind).toBe('rejected')
    expect(classifyWaitTarget('button:has-text("Save")').kind).toBe('rejected')
    expect(classifyWaitTarget('[data-x="ok"] >> span').kind).toBe('rejected')
  })
})

describe('formatWaitResult page line', () => {
  it('appends the page URL when the route supplied one', () => {
    expect(formatWaitResult(classifyWaitTarget('.loaded'), 1840, false, 'https://a.com/done')).toBe('Selector ".loaded" matched after 1840 ms. Page: https://a.com/done')
    expect(formatWaitResult(classifyWaitTarget('.loaded'), 1840, false)).toBe('Selector ".loaded" matched after 1840 ms.')
  })
})
