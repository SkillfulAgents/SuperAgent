import { describe, it, expect } from 'vitest'
import { activeTabAddress, isChromeErrorUrl, resolveErrorPageUrl } from './error-page-url'
import { tabManager } from './tab-manager'

const callback = 'http://localhost:59999/callback?code=abc123&state=xyz'

describe('resolveErrorPageUrl', () => {
  it('reports the address that failed to load instead of Chrome\'s error document', async () => {
    expect(await resolveErrorPageUrl('chrome-error://chromewebdata/', async () => callback)).toBe(callback)
  })

  it('leaves a real page\'s URL alone without asking for the tab', async () => {
    let asked = false
    expect(await resolveErrorPageUrl('https://acme.com/', async () => { asked = true; return callback })).toBe('https://acme.com/')
    expect(asked).toBe(false)
  })

  it('keeps the error URL when the tab cannot be read or reports it too', async () => {
    const err = 'chrome-error://chromewebdata/'
    expect(await resolveErrorPageUrl(err, async () => { throw new Error('daemon down') })).toBe(err)
    expect(await resolveErrorPageUrl(err, async () => null)).toBe(err)
    expect(await resolveErrorPageUrl(err, async () => '')).toBe(err)
    expect(await resolveErrorPageUrl(err, async () => err)).toBe(err)
  })

  it('recognises the error scheme only', () => {
    expect(isChromeErrorUrl('chrome-error://chromewebdata/')).toBe(true)
    expect(isChromeErrorUrl('https://chrome-error.example/')).toBe(false)
  })
})

describe('activeTabAddress', () => {
  const err = 'chrome-error://chromewebdata/'
  const match = (a: string, b: string) => tabManager.urlsMatch(a, b)
  const noTargets = async (): Promise<Array<{ url: string }>> => { throw new Error('targets must not be read') }

  it('takes the daemon\'s URL for the active tab while it still knows the address', async () => {
    const tabs = [{ url: 'https://example.com/', active: false }, { url: callback, active: true }]
    expect(await activeTabAddress(tabs, noTargets, match)).toBe(callback)
  })

  it('pairs the error tab with the one target no other tab claims', async () => {
    // Chrome lists targets in its own order, not the daemon's.
    const tabs = [{ url: err, active: true }, { url: 'https://example.org/', active: false }]
    const targets = [{ url: 'https://example.org/' }, { url: callback }]
    expect(await activeTabAddress(tabs, async () => targets, match)).toBe(callback)
    expect(targets).toHaveLength(2)
  })

  it('gives no answer when the pairing is not unique', async () => {
    const two = [{ url: err, active: true }, { url: err, active: false }]
    expect(await activeTabAddress(two, noTargets, match)).toBeNull()

    const tabs = [{ url: err, active: true }, { url: 'https://example.org/', active: false }]
    expect(await activeTabAddress(tabs, async () => [{ url: callback }], match)).toBeNull()
    expect(await activeTabAddress(tabs, async () => [{ url: callback }, { url: 'https://other.com/' }], match)).toBeNull()
    expect(await activeTabAddress([{ url: err, active: false }], noTargets, match)).toBeNull()
  })
})
