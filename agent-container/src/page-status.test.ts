import { describe, it, expect } from 'vitest'
import { EMPTY_OBSERVATION, type PageObservation } from './page-observer'
import { formatStatusLine, isQuiet, isThinPage, landedElsewhere, pageWarnings, waitForQuiet } from './page-status'

const healthy: PageObservation = { ...EMPTY_OBSERVATION, url: 'https://acme.com/checkout', title: 'Checkout — Acme', readyState: 'complete', httpStatus: 200, contentType: 'text/html' }

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('isQuiet / waitForQuiet', () => {
  it('is quiet when loaded with nothing transient in progress', () => {
    expect(isQuiet(healthy)).toBe(true)
    expect(isQuiet({ ...healthy, readyState: 'loading' })).toBe(false)
    expect(isQuiet({ ...healthy, pending: 1 })).toBe(false)
    expect(isQuiet({ ...healthy, busy: [{ kind: 'spinner', name: '', count: 1 }] })).toBe(false)
    // A permanent progressbar or aria-busy region must not hold every snapshot for the cap.
    expect(isQuiet({ ...healthy, busy: [{ kind: 'progressbar', name: '', count: 1 }, { kind: 'aria-busy', name: '', count: 1 }] })).toBe(true)
  })

  it('returns at once on a quiet page, polls until quiet otherwise, and gives up at the cap', async () => {
    let reads = 0
    const c = clock()
    expect(await waitForQuiet(async () => { reads++; return healthy }, { ...c })).toEqual({ obs: healthy, waitedMs: 0, quiet: true })
    expect(reads).toBe(1)

    const states: PageObservation[] = [{ ...healthy, readyState: 'loading' }, { ...healthy, pending: 2 }, { ...healthy, busy: [{ kind: 'top-bar', name: '', count: 1 }] }, healthy]
    const out = await waitForQuiet(async () => states.shift() ?? healthy, { ...c, pollMs: 150 })
    expect(out).toEqual({ obs: healthy, waitedMs: 450, quiet: true })

    const slow = await waitForQuiet(async () => ({ ...healthy, pending: 1 }), { ...clock(), capMs: 2000, pollMs: 150 })
    expect(slow.quiet).toBe(false)
    expect(slow.waitedMs).toBeGreaterThanOrEqual(2000)

    const dead = await waitForQuiet(async () => null, { ...clock() })
    expect(dead).toEqual({ obs: null, waitedMs: 0, quiet: false })
  })
})

describe('pageWarnings / formatStatusLine', () => {
  it('is one clean line for a healthy page', () => {
    expect(pageWarnings(healthy, 84)).toEqual([])
    expect(formatStatusLine(healthy, 84)).toBe('[page] https://acme.com/checkout · "Checkout — Acme" · HTTP 200 · complete · 84 refs')
  })

  it('omits HTTP when unknown and refs when not counted, and is empty without a URL', () => {
    expect(formatStatusLine({ ...healthy, httpStatus: 0, title: '' }, null)).toBe('[page] https://acme.com/checkout · untitled · complete')
    expect(formatStatusLine(EMPTY_OBSERVATION, 3)).toBe('')
  })

  it('warns, most invalidating first, as observations', () => {
    const bad = { ...healthy, httpStatus: 429, blocker: 'Cloudflare', readyState: 'loading', busy: [{ kind: 'spinner', name: '', count: 1 }], pending: 2 }
    const warns = pageWarnings(bad, 0)
    expect(warns.map(w => w.split(' ')[0])).toEqual(['bot-block:', 'HTTP', 'page', 'page'])
    expect(warns[0]).toContain('request_browser_input')
    expect(warns[1]).toContain('rate limited')
    expect(warns[2]).toBe('page still loading — content may be incomplete.')
    expect(warns[3]).toBe('page still active: spinner, 2 requests in flight.')
    expect(warns.join('\n')).not.toMatch(/browser_wait|check the URL/)
    expect(formatStatusLine(bad, 0).split('\n')).toHaveLength(5)
  })

  it('names the wait when the snapshot held for a loading or active page', () => {
    expect(pageWarnings({ ...healthy, readyState: 'loading' }, 0, { waitedMs: 2010 })[0]).toMatch(/^page still loading after waiting 2\.0s — /)
    expect(pageWarnings({ ...healthy, pending: 1 }, 5, { waitedMs: 2010 })[0]).toMatch(/^page still active after waiting 2\.0s: 1 request in flight/)
    expect(pageWarnings({ ...healthy, readyState: 'loading' }, 0, { waitedMs: 30 })[0]).toMatch(/^page still loading — /)
  })

  it('explains an empty tree only when nothing else does, and flags 401/404/non-HTML', () => {
    expect(pageWarnings(healthy, 0)[0]).toContain('no interactive elements')
    expect(pageWarnings({ ...healthy, netError: 'ERR_CONNECTION_REFUSED' }, 0)).toHaveLength(1)
    expect(pageWarnings({ ...healthy, netError: 'net error' }, 0)[0]).toMatch(/^site unreachable — /)
    expect(pageWarnings({ ...healthy, httpStatus: 401 }, 1)[0]).toContain('authentication required')
    expect(pageWarnings({ ...healthy, httpStatus: 404 }, 1)[0]).toContain('not found')
    expect(pageWarnings({ ...healthy, contentType: 'application/json' }, 1)[0]).toContain('raw application/json document')
    expect(pageWarnings({ ...healthy, contentType: 'application/pdf' }, 1)[0]).toMatch(/^PDF document.*browser_download/)
  })

  it('treats an error status as a fact, not a warning, when the page has a real tree (an SPA on a 404 fallback)', () => {
    expect(pageWarnings({ ...healthy, httpStatus: 404 }, 61)).toEqual([])
    expect(formatStatusLine({ ...healthy, httpStatus: 404 }, 61)).toBe('[page] https://acme.com/checkout · "Checkout — Acme" · HTTP 404 · complete · 61 refs')
    // Without a ref count (browser_open), the observer's own census decides.
    expect(isThinPage({ ...healthy, interactive: 40 }, null)).toBe(false)
    expect(isThinPage({ ...healthy, interactive: 2 }, null)).toBe(true)
    expect(pageWarnings({ ...healthy, httpStatus: 403, interactive: 40 }, null)).toEqual([])
  })
})

describe('landedElsewhere', () => {
  it('ignores scheme, trailing slash, fragment and host case; detects other paths or hosts', () => {
    expect(landedElsewhere('example.com', 'https://example.com/')).toBe(false)
    expect(landedElsewhere('http://Example.com/a/', 'https://example.com/a#top')).toBe(false)
    expect(landedElsewhere('https://app.com/dashboard', 'https://app.com/login?next=%2Fdashboard')).toBe(true)
    expect(landedElsewhere('https://a.com', 'https://b.com')).toBe(true)
    expect(landedElsewhere('not a url', 'https://b.com')).toBe(false)
  })
})
