// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { isPrivateHost } from '@shared/lib/utils/url-safety'
import { SiteFavicon, vendorFaviconHref } from './site-favicon'

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
  // module pulls node:dns at top level and must not reach the renderer bundle. Pin the two
  // together here instead of asking a comment to hold them in step. Tests run in Node, so
  // importing the real one is fine.
  it('agrees with the url-safety host list it copies', () => {
    for (const host of [
      'localhost', 'foo.localhost', 'printer.local', 'localhost.', 'ip6-localhost',
      '0.0.0.0', '10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
      '100.64.0.1', '172.32.0.1', '100.128.0.1', '8.8.8.8', 'example.com',
      '[::1]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[2001:4860::8888]',
    ]) {
      const url = new URL(`https://${host}/i.png`)
      const copyBlocks = vendorFaviconHref(url.toString()) === null
      expect([host, copyBlocks]).toEqual([host, isPrivateHost(url.hostname)])
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

describe('SiteFavicon', () => {
  it('retries a new src after a previous one failed to load', () => {
    // The failure is per-href, not per-instance: a mounted instance whose icon 404'd must not
    // keep showing the globe once it receives a different, valid icon URL.
    const { container, rerender } = render(<SiteFavicon src="https://a.com/broken.png" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg'), 'globe fallback after a load failure').not.toBeNull()
    rerender(<SiteFavicon src="https://b.com/i.png" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://b.com/i.png')
  })
})
