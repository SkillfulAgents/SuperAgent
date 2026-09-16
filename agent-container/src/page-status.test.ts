import { describe, it, expect } from 'vitest'
import { EMPTY_OBSERVATION, type PageObservation } from './page-observer'
import { formatStatusLine, landedElsewhere, pageWarnings, waitForLoaded } from './page-status'

const healthy: PageObservation = { ...EMPTY_OBSERVATION, url: 'https://acme.com/checkout', title: 'Checkout — Acme', readyState: 'complete', httpStatus: 200, contentType: 'text/html' }

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('waitForLoaded', () => {
  it('returns at once on a loaded page, polls while the document is loading, and gives up at the cap', async () => {
    let reads = 0
    const c = clock()
    expect(await waitForLoaded(async () => { reads++; return healthy }, { ...c })).toEqual({ obs: healthy, waitedMs: 0 })
    expect(reads).toBe(1)

    const states: PageObservation[] = [{ ...healthy, readyState: 'loading' }, { ...healthy, readyState: 'interactive' }, healthy]
    expect(await waitForLoaded(async () => states.shift() ?? healthy, { ...c, pollMs: 150 })).toEqual({ obs: healthy, waitedMs: 300 })

    const slow = await waitForLoaded(async () => ({ ...healthy, readyState: 'interactive' }), { ...clock(), capMs: 2000, pollMs: 150 })
    expect(slow.obs?.readyState).toBe('interactive')
    expect(slow.waitedMs).toBeGreaterThanOrEqual(2000)

    // A read that fails ends the wait; an observation with no readyState (unknown) is not waited on.
    expect(await waitForLoaded(async () => null, { ...clock() })).toEqual({ obs: null, waitedMs: 0 })
    expect((await waitForLoaded(async () => ({ ...healthy, readyState: '' }), { ...clock() })).waitedMs).toBe(0)
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

  it('warns, most invalidating first, as observations without advice', () => {
    const bad = { ...healthy, blocker: 'Cloudflare', contentType: 'text/plain', readyState: 'loading' }
    const warns = pageWarnings(bad, 0)
    expect(warns).toEqual([
      'Cloudflare challenge page — the site is challenging automated access; what follows is the challenge, not the site.',
      'raw text/plain document, not a web page — the tree shows Chrome\'s viewer.',
      'page still loading — content may be incomplete.',
    ])
    expect(warns.join('\n')).not.toMatch(/browser_wait|request_browser_input|check the URL|re-snapshot/)
    expect(formatStatusLine(bad, 0).split('\n')).toHaveLength(4)
  })

  it('names the wait when the snapshot held for a loading page', () => {
    expect(pageWarnings({ ...healthy, readyState: 'loading' }, 0, { waitedMs: 2010 })[0]).toBe('page still loading after waiting 2.0s — content may be incomplete.')
    expect(pageWarnings({ ...healthy, readyState: 'interactive' }, 0, { waitedMs: 30 })[0]).toBe('page still interactive — content may be incomplete.')
  })

  it('reports an HTTP error status as a fact in the line, never as a warning', () => {
    expect(pageWarnings({ ...healthy, httpStatus: 404 }, 1)).toEqual([])
    expect(formatStatusLine({ ...healthy, httpStatus: 404 }, 61)).toBe('[page] https://acme.com/checkout · "Checkout — Acme" · HTTP 404 · complete · 61 refs')
    expect(formatStatusLine({ ...healthy, httpStatus: 401 }, 0)).toContain('⚠ no interactive elements')
  })

  it('explains an empty tree only when nothing else does, and names Chrome\'s error page', () => {
    expect(pageWarnings(healthy, 0)[0]).toContain('no interactive elements')
    expect(pageWarnings({ ...healthy, netError: 'ERR_CONNECTION_REFUSED' }, 0)).toEqual(['site unreachable (ERR_CONNECTION_REFUSED) — this is Chrome\'s error page, not the site. Check the URL or retry.'])
    expect(pageWarnings({ ...healthy, netError: 'net error' }, 0)[0]).toMatch(/^site unreachable — /)
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
