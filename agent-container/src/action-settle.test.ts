import { describe, it, expect } from 'vitest'
import { EMPTY_OBSERVATION, type PageObservation } from './page-observer'
import {
  ACTION_POLICIES,
  diffObservations,
  effectHasChange,
  formatActionEffect,
  observeAction,
  pressPolicy,
} from './action-settle'

const base: PageObservation = {
  ...EMPTY_OBSERVATION, url: 'https://a.com', readyState: 'complete', interactive: 40, textChars: 500, contentChars: 500, contentHash: 1, stateHash: 7, focus: 'nothing focused', focusId: 'body@-1',
}
/** A focused field with a value, the way the observer reports it: preview, length, hash of the whole value. */
const field = (focus: string, focusId: string, value: string): PageObservation => ({
  ...base, focus, focusId, focusValue: value.slice(0, 120), focusValueChars: value.length, focusValueHash: value.split('').reduce((h, c) => ((h << 5) + h + c.charCodeAt(0)) | 0, 5381),
})

describe('diffObservations', () => {
  it('reports dialogs, announcements, census, control state, text size and typed values', () => {
    const before: PageObservation = { ...base, top: [{ kind: 'dialog', name: 'Cart' }], liveRegions: ['Saved'] }
    const after: PageObservation = {
      ...base, interactive: 52, contentChars: 620, contentHash: 2,
      top: [{ kind: 'dialog', name: 'Create new app' }], liveRegions: ['Saved', 'Tags updated'],
    }
    expect(diffObservations(before, after)).toEqual({
      opened: [{ kind: 'dialog', name: 'Create new app' }],
      closed: [{ kind: 'dialog', name: 'Cart' }],
      interactiveDelta: 12,
      stateChanged: false,
      announced: ['Tags updated'],
      textChanged: true,
      textDelta: 120,
      focus: 'nothing focused',
      focusChanged: false,
      focusValueChanged: false,
      focusValue: '',
      focusValueChars: 0,
    })
  })

  it('reports a control state change, and ignores a same-length text change (a clock, a counter)', () => {
    expect(diffObservations(base, { ...base, stateHash: 8 })).toMatchObject({ stateChanged: true, textChanged: false })
    expect(diffObservations(base, { ...base, contentHash: 2 })).toMatchObject({ textChanged: false, textDelta: 0 })
    expect(diffObservations(base, { ...base, contentHash: 2, contentChars: 512 })).toMatchObject({ textChanged: true, textDelta: 12 })
  })

  it('counts a typed value only when focus stayed on the same element — by identity, not by name', () => {
    expect(diffObservations(field('textbox "A"', 'input#a@3', ''), field('textbox "A"', 'input#a@3', 'monday'))).toMatchObject({ focusValueChanged: true, focusValue: 'monday', focusChanged: false })
    expect(diffObservations(field('textbox "A"', 'input#a@3', 'x'), field('textbox "B"', 'input#b@4', ''))).toMatchObject({ focusValueChanged: false, focusChanged: true })
    // Tab between two unnamed inputs holding "first" and "second": a focus move, not an edit.
    expect(diffObservations(field('textbox', 'input@0', 'first'), field('textbox', 'input@1', 'second'))).toMatchObject({ focusValueChanged: false, focusChanged: true })
  })

  it('detects an edit beyond the preview and says the preview is one', () => {
    const before = field('textbox "Notes"', 'textarea#n@2', 'x'.repeat(165))
    const after = field('textbox "Notes"', 'textarea#n@2', 'x'.repeat(164))
    expect(before.focusValue).toBe(after.focusValue) // the preview did not change…
    const e = diffObservations(before, after)
    expect(e.focusValueChanged).toBe(true) // …the value did
    expect(formatActionEffect(e, { settleMs: 50, verb: 'press' })).toBe(`\nEffect: field value now ${JSON.stringify('x'.repeat(120))} (164 chars, first 120 shown) · focus: textbox "Notes"`)
    expect(formatActionEffect(diffObservations(field('textbox "S"', 'input@0', ''), field('textbox "S"', 'input@0', 'monday')), { settleMs: 50, verb: 'press' })).toBe('\nEffect: field value now "monday" · focus: textbox "S"')
  })
})

describe('effectHasChange', () => {
  it('a focus move counts for press but not for click, which moves focus itself; a state change always counts', () => {
    const moved = diffObservations(base, { ...base, focus: 'button "Add to cart"' })
    expect(effectHasChange(moved, { countFocus: true })).toBe(true)
    expect(effectHasChange(moved, { countFocus: false })).toBe(false)
    expect(effectHasChange(diffObservations(base, { ...base, stateHash: 1 }), { countFocus: false })).toBe(true)
    expect(effectHasChange(diffObservations(base, { ...base }))).toBe(false)
  })
})

describe('formatActionEffect', () => {
  it('leads with what a person would notice', () => {
    const effect = diffObservations({ ...base, top: [{ kind: 'dialog', name: 'Cart' }] }, { ...base, interactive: 52, liveRegions: ['Cart Error'] })
    expect(formatActionEffect(effect, { settleMs: 300, verb: 'click' })).toBe('\nEffect: dialog "Cart" closed · announced: "Cart Error" · +12 interactive elements')
  })

  it('sizes a text change, reports control state and typed values', () => {
    expect(formatActionEffect(diffObservations(base, { ...base, contentHash: 9, contentChars: 1734 }), { settleMs: 300, verb: 'click' })).toBe('\nEffect: page text changed (+1,234 chars)')
    expect(formatActionEffect(diffObservations(base, { ...base, stateHash: 9 }), { settleMs: 300, verb: 'click' })).toBe('\nEffect: control state changed (checked/pressed/expanded/selected)')
    const typed = diffObservations(field('textbox "Search"', 'input#q@0', ''), field('textbox "Search"', 'input#q@0', 'monday'))
    expect(formatActionEffect(typed, { settleMs: 50, verb: 'press' })).toBe('\nEffect: field value now "monday" · focus: textbox "Search"')
  })

  it('states that nothing was observed, and what was looked at, with no verdict on why', () => {
    const none = diffObservations(base, { ...base })
    const scope = '(dialogs, live regions, page text, control state, focus)'
    expect(formatActionEffect(none, { settleMs: 1206, verb: 'click' })).toBe(`\nEffect: none observed within 1206ms ${scope}`)
    expect(formatActionEffect(none, { settleMs: 300, verb: 'hover' })).toBe(`\nEffect: none observed within 300ms ${scope}`)
    expect(formatActionEffect(none, { settleMs: 300, verb: 'select' })).toBe(`\nEffect: none observed within 300ms ${scope}`)
    expect(formatActionEffect(none, { settleMs: 300, verb: 'click' })).not.toMatch(/may|probably|swallowed|disabled|browser_wait/)
    // A same-length text change is a ticker, not an effect.
    expect(formatActionEffect(diffObservations(base, { ...base, contentHash: 9 }), { settleMs: 300, verb: 'click' })).toBe(`\nEffect: none observed within 300ms ${scope}`)
  })

  it('reports focus: where the next key goes after a press, which element took a click', () => {
    expect(formatActionEffect(diffObservations({ ...base, focus: 'textbox "S"' }, { ...base, focus: 'textbox "S"' }), { settleMs: 50, verb: 'press' })).toMatch(/^\nEffect: none observed within 50ms \(.*\) — focus: textbox "S"$/)
    expect(formatActionEffect(diffObservations(base, { ...base, focus: 'link "Wikipedia"' }), { settleMs: 50, verb: 'press' })).toBe('\nEffect: focus: link "Wikipedia"')
    expect(formatActionEffect(diffObservations(base, { ...base, focus: 'textbox "Password"' }), { settleMs: 1200, verb: 'click' })).toBe('\nEffect: focus: textbox "Password"')
    expect(formatActionEffect(diffObservations({ ...base, focus: 'button "Go"' }, { ...base, focus: 'button "Go"', interactive: 41 }), { settleMs: 300, verb: 'click' })).toBe('\nEffect: +1 interactive elements')
  })

  it('is empty without an effect (read failed or page navigated)', () => {
    expect(formatActionEffect(null, { settleMs: 300, verb: 'click' })).toBe('')
  })
})

// ---------------------------------------------------------------------------
// observeAction against a scripted page: each entry in `reads` is what the
// next observer eval returns (null = eval failed). The clock is virtual.
// ---------------------------------------------------------------------------
function harness(reads: Array<PageObservation | null>) {
  let t = 0
  const evals: number[] = []
  return {
    evals,
    run: (policy = ACTION_POLICIES.click, fail = false) => observeAction({
      exec: async () => ({ exitCode: fail ? 1 : 0 }),
      isFailure: r => r.exitCode !== 0,
      evalScript: async () => {
        evals.push(t)
        const next = reads.shift()
        return next === undefined ? null : next === null ? null : JSON.stringify(next)
      },
      policy,
      sleep: async (ms: number) => { t += ms },
      now: () => t,
    }),
  }
}

describe('observeAction', () => {
  it('reads a baseline, acts, settles, and reports a change found at the settle', async () => {
    const h = harness([base, { ...base, interactive: 52, top: [{ kind: 'dialog', name: 'Filters' }] }])
    const out = await h.run()
    expect(out.effect?.opened).toEqual([{ kind: 'dialog', name: 'Filters' }])
    expect(out.waitedMs).toBe(300)
    expect(h.evals).toEqual([0, 300])
  })

  it('on silence at the settle, reads once more at the recheck before reporting nothing', async () => {
    const h = harness([base, { ...base }, { ...base, interactive: 52 }])
    const out = await h.run()
    expect(out.effect?.interactiveDelta).toBe(12)
    expect(out.waitedMs).toBe(1200)
    expect(h.evals).toEqual([0, 300, 1200])
  })

  it('reports nothing across a navigation, after a failed action, or when the page cannot be read', async () => {
    const nav = await harness([base, { ...base, url: 'https://a.com/next', interactive: 3 }]).run()
    expect(nav.effect).toBeNull()
    expect(nav.after?.url).toBe('https://a.com/next')

    const h = harness([base])
    const failed = await h.run(ACTION_POLICIES.click, true)
    expect(failed.effect).toBeNull()
    expect(h.evals).toHaveLength(1)

    const dead = await harness([null, null]).run()
    expect(dead.effect).toBeNull()
    expect(dead.before).toBeNull()
  })

  it('skips the recheck where a late effect is implausible: a click that landed focus in a text field', async () => {
    const h = harness([base, { ...base, focus: 'textbox "Email"' }])
    const out = await h.run(ACTION_POLICIES.click)
    expect(out.waitedMs).toBe(300)
    expect(h.evals).toEqual([0, 300])
    expect(formatActionEffect(out.effect, { settleMs: out.waitedMs, verb: 'click' })).toBe('\nEffect: focus: textbox "Email"')
    // A click that landed focus on a button still gets the recheck: a drawer may follow.
    const h2 = harness([base, { ...base, focus: 'button "Add to cart"' }, { ...base, focus: 'button "Add to cart"', top: [{ kind: 'dialog', name: 'Cart' }] }])
    const out2 = await h2.run(ACTION_POLICIES.click)
    expect(h2.evals).toEqual([0, 300, 1200])
    expect(out2.effect?.opened).toEqual([{ kind: 'dialog', name: 'Cart' }])
  })

  it('never rechecks a hover', async () => {
    const h = harness([base, { ...base }])
    const out = await h.run(ACTION_POLICIES.hover)
    expect(out.waitedMs).toBe(300)
    expect(h.evals).toEqual([0, 300])
  })

  it('rechecks a press only for keys that submit or activate, including at the end of a combo', async () => {
    for (const key of ['Enter', ' Return ', 'Space', 'Control+Enter', 'Shift+Enter']) {
      const h = harness([base, { ...base }, { ...base, interactive: 52 }])
      const out = await h.run(pressPolicy(key))
      expect(h.evals).toEqual([0, 300, 1200])
      expect(out.effect?.interactiveDelta).toBe(12)
    }
    for (const key of ['Tab', 'Escape', 'ArrowDown', 'Control+a', 'a']) {
      const h = harness([base, { ...base, focus: 'link "Next"' }])
      const out = await h.run(pressPolicy(key))
      expect(out.waitedMs).toBe(50)
      expect(out.effect?.focusChanged).toBe(true)
      expect(h.evals).toEqual([0, 50])
    }
  })
})
