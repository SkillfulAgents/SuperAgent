import { describe, it, expect } from 'vitest'
import { EMPTY_OBSERVATION, type PageObservation } from './page-observer'
import {
  ACTION_POLICIES,
  diffObservations,
  effectHasChange,
  effectIsBusy,
  formatActionEffect,
  observeAction,
} from './action-settle'

const base: PageObservation = {
  ...EMPTY_OBSERVATION, t: 1000, url: 'https://a.com', readyState: 'complete', interactive: 40, textChars: 500, contentChars: 500, contentHash: 1, stateHash: 7, focus: 'nothing focused',
}

describe('diffObservations', () => {
  it('reports dialogs, announcements, census, text size, typed values, failed requests and new busy signals', () => {
    const before: PageObservation = { ...base, top: [{ kind: 'dialog', name: 'Cart' }], liveRegions: ['Saved'], busy: [{ kind: 'progressbar', name: 'Upload', count: 1 }] }
    const after: PageObservation = {
      ...base, interactive: 52, contentChars: 620, contentHash: 2,
      top: [{ kind: 'dialog', name: 'Create new app' }], liveRegions: ['Saved', 'Tags updated'],
      failed: [{ url: '/cart/add.json', status: 422, initiator: 'fetch' }], pending: 1,
      busy: [{ kind: 'progressbar', name: 'Upload', count: 1 }, { kind: 'spinner', name: '', count: 1 }],
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
      failed: [{ url: '/cart/add.json', status: 422, initiator: 'fetch' }],
      busy: [{ kind: 'spinner', name: '', count: 1 }],
      pending: 1,
    })
  })

  it('reports a control state change, and ignores a same-length text change (a clock, a counter)', () => {
    expect(diffObservations(base, { ...base, stateHash: 8 })).toMatchObject({ stateChanged: true, textChanged: false })
    expect(diffObservations(base, { ...base, contentHash: 2 })).toMatchObject({ textChanged: false, textDelta: 0 })
    expect(diffObservations(base, { ...base, contentHash: 2, contentChars: 512 })).toMatchObject({ textChanged: true, textDelta: 12 })
  })

  it('counts a typed value only when focus stayed on the same field', () => {
    expect(diffObservations({ ...base, focus: 'textbox "A"', focusValue: '' }, { ...base, focus: 'textbox "A"', focusValue: 'monday' })).toMatchObject({ focusValueChanged: true, focusValue: 'monday', focusChanged: false })
    expect(diffObservations({ ...base, focus: 'textbox "A"', focusValue: 'x' }, { ...base, focus: 'textbox "B"', focusValue: '' })).toMatchObject({ focusValueChanged: false, focusChanged: true })
  })
})

describe('effectHasChange / effectIsBusy', () => {
  it('a focus move counts for press but not for click, which moves focus itself; a state change always counts', () => {
    const moved = diffObservations(base, { ...base, focus: 'button "Add to cart"' })
    expect(effectHasChange(moved, { countFocus: true })).toBe(true)
    expect(effectHasChange(moved, { countFocus: false })).toBe(false)
    expect(effectHasChange(diffObservations(base, { ...base, stateHash: 1 }), { countFocus: false })).toBe(true)
    expect(effectHasChange(diffObservations(base, { ...base }))).toBe(false)
  })

  it('is busy on requests in flight or a new transient indicator, not on a permanent progressbar', () => {
    expect(effectIsBusy(diffObservations(base, { ...base, pending: 1 }))).toBe(true)
    expect(effectIsBusy(diffObservations(base, { ...base, busy: [{ kind: 'top-bar', name: '', count: 1 }] }))).toBe(true)
    expect(effectIsBusy(diffObservations(base, { ...base, busy: [{ kind: 'progressbar', name: '', count: 1 }] }))).toBe(false)
    expect(effectIsBusy(diffObservations(base, { ...base }))).toBe(false)
  })
})

describe('formatActionEffect', () => {
  it('leads with what a person would notice', () => {
    const effect = diffObservations({ ...base, top: [{ kind: 'dialog', name: 'Cart' }] }, { ...base, interactive: 52, liveRegions: ['Cart Error'], failed: [{ url: '/cart/add.js', status: 422, initiator: 'fetch' }] })
    expect(formatActionEffect(effect, { settleMs: 300, verb: 'click' })).toBe('\nEffect: dialog "Cart" closed · announced: "Cart Error" · failed request: fetch /cart/add.js → 422 · +12 interactive elements')
  })

  it('calls an aborted or unreachable request a network error rather than status 0', () => {
    const effect = diffObservations(base, { ...base, failed: [{ url: '10.255.255.1/x', status: 0, initiator: 'fetch' }] })
    expect(formatActionEffect(effect, { settleMs: 300, verb: 'click' })).toBe('\nEffect: failed request: fetch 10.255.255.1/x → network error')
  })

  it('sizes a text change, reports control state and typed values', () => {
    expect(formatActionEffect(diffObservations(base, { ...base, contentHash: 9, contentChars: 1734 }), { settleMs: 300, verb: 'click' })).toBe('\nEffect: page text changed (+1,234 chars)')
    expect(formatActionEffect(diffObservations(base, { ...base, stateHash: 9 }), { settleMs: 300, verb: 'click' })).toBe('\nEffect: control state changed (checked/pressed/expanded/selected)')
    const typed = diffObservations({ ...base, focus: 'textbox "Search"' }, { ...base, focus: 'textbox "Search"', focusValue: 'monday' })
    expect(formatActionEffect(typed, { settleMs: 50, verb: 'press' })).toBe('\nEffect: field value now "monday" · focus: textbox "Search"')
  })

  it('states that nothing was observed, and what was looked at, with no verdict on why', () => {
    const none = diffObservations(base, { ...base })
    const scope = '(dialogs, live regions, page text, control state, focus)'
    expect(formatActionEffect(none, { settleMs: 1206, verb: 'click' })).toBe(`\nEffect: none observed within 1206ms ${scope}`)
    expect(formatActionEffect(none, { settleMs: 300, verb: 'hover' })).toBe(`\nEffect: none observed within 300ms ${scope}`)
    expect(formatActionEffect(none, { settleMs: 300, verb: 'select' })).toBe(`\nEffect: none observed within 300ms ${scope}`)
    expect(formatActionEffect(none, { settleMs: 300, verb: 'click' })).not.toMatch(/may|probably|swallowed|disabled/)
    // A same-length text change is a ticker, not an effect.
    expect(formatActionEffect(diffObservations(base, { ...base, contentHash: 9 }), { settleMs: 300, verb: 'click' })).toBe(`\nEffect: none observed within 300ms ${scope}`)
  })

  it('says nothing for a scroll that changed nothing — the viewport line is the fact', () => {
    expect(formatActionEffect(diffObservations(base, { ...base }), { settleMs: 300, verb: 'scroll' })).toBe('')
    expect(formatActionEffect(diffObservations(base, { ...base, interactive: 64 }), { settleMs: 300, verb: 'scroll' })).toBe('\nEffect: +24 interactive elements')
  })

  it('reports focus: where the next key goes after a press, which element took a click', () => {
    expect(formatActionEffect(diffObservations({ ...base, focus: 'textbox "S"' }, { ...base, focus: 'textbox "S"' }), { settleMs: 50, verb: 'press' })).toMatch(/^\nEffect: none observed within 50ms \(.*\) — focus: textbox "S"$/)
    expect(formatActionEffect(diffObservations(base, { ...base, focus: 'link "Wikipedia"' }), { settleMs: 50, verb: 'press' })).toBe('\nEffect: focus: link "Wikipedia"')
    expect(formatActionEffect(diffObservations(base, { ...base, focus: 'textbox "Password"' }), { settleMs: 1200, verb: 'click' })).toBe('\nEffect: focus: textbox "Password"')
    expect(formatActionEffect(diffObservations({ ...base, focus: 'button "Go"' }, { ...base, focus: 'button "Go"', interactive: 41 }), { settleMs: 300, verb: 'click' })).toBe('\nEffect: +1 interactive elements')
  })

  it('says the page was still active at the cap, with what was going on and what had landed so far', () => {
    const busy = diffObservations(base, { ...base, interactive: 43, pending: 2, busy: [{ kind: 'spinner', name: '', count: 1 }] })
    expect(formatActionEffect(busy, { settleMs: 2004, verb: 'click', stillBusy: true })).toBe(
      '\nEffect: page still active after 2.0s (spinner, 2 requests in flight). So far: +3 interactive elements.',
    )
    const nothingYet = diffObservations(base, { ...base, pending: 1 })
    expect(formatActionEffect(nothingYet, { settleMs: 2001, verb: 'press', stillBusy: true })).toBe(
      '\nEffect: page still active after 2.0s (1 request in flight). (focus: nothing focused)',
    )
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
  const evals: Array<{ at: number; since: number | null; baseline: boolean }> = []
  return {
    evals,
    now: () => t,
    run: (policy = ACTION_POLICIES.click, fail = false) => observeAction({
      exec: async () => ({ exitCode: fail ? 1 : 0 }),
      isFailure: r => r.exitCode !== 0,
      evalScript: async (script: string) => {
        const since = /var since=([\d.]+|null);/.exec(script)?.[1] ?? 'null'
        evals.push({ at: t, since: since === 'null' ? null : Number(since), baseline: script.includes('if(true)O.baseAnim') })
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
    const h = harness([base, { ...base, t: 1300, interactive: 52, top: [{ kind: 'dialog', name: 'Filters' }] }])
    const out = await h.run()
    expect(out.effect?.opened).toEqual([{ kind: 'dialog', name: 'Filters' }])
    expect(out.waitedMs).toBe(300)
    expect(out.stillBusy).toBe(false)
    expect(h.evals.map(e => [e.at, e.since, e.baseline])).toEqual([[0, null, true], [300, 1000, false]])
  })

  it('on silence at the settle, reads once more at the recheck before reporting no change', async () => {
    const h = harness([base, { ...base, t: 1300 }, { ...base, t: 2200, interactive: 52 }])
    const out = await h.run()
    expect(out.effect?.interactiveDelta).toBe(12)
    expect(out.waitedMs).toBe(1200)
    expect(h.evals.map(e => e.at)).toEqual([0, 300, 1200])
  })

  it('keeps polling while the page is busy and stops when it is quiet and two reads agree', async () => {
    const h = harness([
      base,
      { ...base, t: 1300, pending: 2, busy: [{ kind: 'spinner', name: '', count: 1 }] },
      { ...base, t: 1500, pending: 1, interactive: 45 },
      { ...base, t: 1700, pending: 0, interactive: 52 },
      { ...base, t: 1900, pending: 0, interactive: 52 },
      { ...base, t: 2100, pending: 0, interactive: 99 }, // never read
    ])
    const out = await h.run()
    expect(out.effect?.interactiveDelta).toBe(12)
    expect(out.effect?.pending).toBe(0)
    expect(out.waitedMs).toBe(900)
    expect(out.stillBusy).toBe(false)
    expect(h.evals.map(e => e.at)).toEqual([0, 300, 500, 700, 900])
  })

  it('gives up at the cap while still busy and says so', async () => {
    const busy = { ...base, t: 1300, pending: 1, interactive: 43 }
    const h = harness([base, busy, busy, busy, busy, busy, busy, busy, busy, busy, busy, busy, busy])
    const out = await h.run()
    expect(out.stillBusy).toBe(true)
    expect(out.effect?.interactiveDelta).toBe(3)
    expect(out.waitedMs).toBe(2000)
    expect(formatActionEffect(out.effect, { settleMs: out.waitedMs, verb: 'click', stillBusy: out.stillBusy })).toContain('page still active after 2.0s (1 request in flight)')
  })

  it('reports nothing across a navigation, after a failed action, or when the page cannot be read', async () => {
    const nav = await harness([base, { ...base, t: 1300, url: 'https://a.com/next', interactive: 3 }]).run()
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

  it('uses the verb policy: a press counts focus and settles faster', async () => {
    const h = harness([{ ...base, focus: 'textbox "S"' }, { ...base, t: 1050, focus: 'link "Next"' }])
    const out = await h.run(ACTION_POLICIES.press)
    expect(out.waitedMs).toBe(50)
    expect(out.effect?.focusChanged).toBe(true)
    expect(h.evals.map(e => e.at)).toEqual([0, 50])
  })
})
