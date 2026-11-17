import { describe, expect, it } from 'vitest'
import type { OutsideCookie } from './browser-session'
import { describeOutside } from './session-outside'

const outside = (domain: string, name: string, valueHash: string, sourcePort?: number): OutsideCookie => ({
  key: JSON.stringify([domain, '/', name, null]),
  domain,
  valueHash,
  ...(sourcePort !== undefined ? { sourcePort } : {}),
})

/** The change as the log prints it. */
function line(...args: Parameters<typeof describeOutside>): string | null {
  const change = describeOutside(...args)
  return change && `${change.onTab} · ${change.elsewhere}`
}

describe('what changed outside a site since its sign-in step', () => {
  it('names the cookie domains of the site the tab landed on, and counts every other domain', () => {
    const before = [outside('.wsj.com', 'consent', 'a1'), outside('.doubleclick.net', 'IDE', 'd1')]
    const after = [
      outside('.wsj.com', 'consent', 'a2'),
      outside('.wsj.com', 'session', 's1'),
      outside('www.wsj.com', 'csrf', 'x1'),
      outside('.doubleclick.net', 'IDE', 'd2'),
      outside('.adnxs.com', 'uuid2', 'u1'),
    ]

    expect(line(before, after, 'wsj.com')).toBe(
      'on the tab\'s site wsj.com: .wsj.com 1 new, 1 changed; www.wsj.com 1 new · 2 cookie(s) on 2 other domain(s)',
    )
  })

  it('shows an app\'s own host cookies beside a parent domain\'s saved ones (Gmail after a Google sign-in)', () => {
    expect(line([], [outside('mail.google.com', 'OSID', 'o1')], 'mail.google.com')).toBe(
      'on the tab\'s site mail.google.com: mail.google.com 1 new · no other domain',
    )
  })

  it('never names a cookie or carries its value', () => {
    const text = line([], [outside('app.example.com', 'secret_session_name', 'hash-of-value')], 'app.example.com')

    expect(text).not.toContain('secret_session_name')
    expect(text).not.toContain('hash-of-value')
  })

  it('is nothing when nothing outside changed, whatever the order', () => {
    const cookies = [outside('.wsj.com', 'a', '1'), outside('.wsj.com', 'b', '2')]

    expect(line(cookies, [...cookies].reverse(), 'wsj.com')).toBeNull()
  })

  it('counts a cookie gone since the step', () => {
    expect(line([outside('.wsj.com', 'guest', 'g1')], [], 'wsj.com')).toBe('on the tab\'s site wsj.com: .wsj.com 1 gone · no other domain')
  })

  it('says so when the tab is still on the account\'s site, or shows no web page', () => {
    const after = [outside('.adnxs.com', 'uuid2', 'u1')]

    expect(line([], after, 'sso.accounts.dowjones.com')).toBe(
      'nothing on the tab\'s site sso.accounts.dowjones.com · 1 cookie(s) on 1 other domain(s)',
    )
    expect(line([], after, null)).toBe('the agent\'s tab shows no web page · 1 cookie(s) on 1 other domain(s)')
  })

  it('tells sites on one host apart by the port that set the cookie', () => {
    const after = [outside('172.17.0.1', 'app_session', 's1', 8107), outside('172.17.0.1', 'other', 'o1', 8108)]

    expect(line([], after, '172.17.0.1:8107')).toBe(
      'on the tab\'s site 172.17.0.1:8107: 172.17.0.1:8107 1 new · 1 cookie(s) on 1 other domain(s)',
    )
  })

  it('names at most eight domains of the tab\'s site', () => {
    const after = Array.from({ length: 10 }, (_, i) => outside(`s${i}.example.com`, 'a', `${i}`))

    expect(line([], after, 'example.com')).toMatch(/s7\.example\.com 1 new; 2 more domain\(s\) · no other domain$/)
  })
})
