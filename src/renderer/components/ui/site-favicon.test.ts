import { describe, expect, it } from 'vitest'
import { isPrivateHost } from '@shared/lib/utils/url-safety'
import { vendorFaviconHref } from './site-favicon'

describe('vendorFaviconHref', () => {
  it('accepts the https icon the search vendor supplied', () => {
    expect(vendorFaviconHref('https://news.yale.edu/sites/default/files/favicons/Yale.png')).toBe(
      'https://news.yale.edu/sites/default/files/favicons/Yale.png',
    )
  })

  it('refuses anything that is not plain https', () => {
    // http would be blocked as mixed content on a web deployment; the rest are not images.
    expect(vendorFaviconHref('http://a.example/icon.png')).toBeNull()
    expect(vendorFaviconHref('javascript:alert(1)')).toBeNull()
    expect(vendorFaviconHref('data:image/png;base64,AAAA')).toBeNull()
    expect(vendorFaviconHref('not a url')).toBeNull()
  })

  it('refuses hosts on this machine or the local network', () => {
    // The icon URL is declared by the fetched page, so a hostile one could point at the reader's
    // own network and every card render would quietly probe it.
    for (const url of [
      'https://localhost/i.png',
      'https://foo.localhost/i.png',
      'https://127.0.0.1/i.png',
      'https://169.254.169.254/i.png',
      'https://192.168.1.1/i.png',
      'https://10.0.0.5/i.png',
      'https://172.16.0.1/i.png',
      'https://100.64.0.1/i.png',
      'https://printer.local/i.png',
      'https://[::1]/i.png',
      'https://[fe81::1]/i.png',
      'https://[::ffff:127.0.0.1]/i.png',
    ]) {
      expect(vendorFaviconHref(url), url).toBeNull()
    }
  })

  // site-favicon.tsx copies url-safety's isPrivateHost rather than importing it, because that
  // module pulls node:dns at top level and must not reach the renderer bundle. The copy is only
  // safe while it stays at least as strict as the original, so pin that here instead of asking
  // a comment to hold the two in step. Tests run in Node, so importing the real one is fine.
  it('is never weaker than the url-safety host list it copies', () => {
    // Deliberately stricter in the copy: a trailing dot is the same name to a resolver, and
    // url-safety does not strip it. Remove an entry here only by fixing url-safety.
    const STRICTER = new Set(['localhost.'])
    for (const host of [
      'localhost', 'foo.localhost', 'printer.local', 'localhost.', 'ip6-localhost',
      '0.0.0.0', '10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
      '100.64.0.1', '172.32.0.1', '100.128.0.1', '8.8.8.8', 'example.com',
      '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[2001:4860::8888]',
    ]) {
      const url = new URL(`https://${host}/i.png`)
      const canonicalBlocks = isPrivateHost(url.hostname)
      const copyBlocks = vendorFaviconHref(url.toString()) === null
      if (STRICTER.has(host)) expect([host, copyBlocks, canonicalBlocks]).toEqual([host, true, false])
      else expect([host, copyBlocks]).toEqual([host, canonicalBlocks])
    }
  })

  it('does not mistake public hosts for private ones', () => {
    // fc/fd only mean unique-local on an IPv6 literal; matching them as a string prefix hid
    // real sites.
    for (const url of [
      'https://fca.example/i.png',
      'https://fd.example/i.png',
      'https://fe80s.example/i.png',
      'https://172.32.0.1/i.png',
      'https://100.63.0.1/i.png',
    ]) {
      expect(vendorFaviconHref(url), url).not.toBeNull()
    }
  })
})
