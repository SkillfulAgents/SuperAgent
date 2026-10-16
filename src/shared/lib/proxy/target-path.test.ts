import { describe, it, expect } from 'vitest'
import { canonicalizeTargetPath, rawRouteTail, type TargetPath } from './target-path'

const ROUTE = '/api/proxy/:agentSlug/:accountId/:rest{.+}'

/**
 * Run `tail` (`<host>/<path>`) through what the real route sees: the request
 * URL is parsed (as the HTTP adapter does), the raw tail is read from it, and
 * the host is taken from the decoded tail (as Hono's param gives it).
 */
function canonicalize(tail: string): TargetPath & { host: string } {
  const rawTail = rawRouteTail(`http://localhost/api/proxy/agent/acc-1/${tail}`, ROUTE, 'rest')
  const host = decodeURIComponent(rawTail.split('/')[0]).split('/')[0]
  return { ...canonicalizeTargetPath(rawTail, host), host }
}

function accepted(tail: string) {
  const result = canonicalize(tail)
  if (!result.ok) throw new Error(`expected ${tail} to be accepted, got: ${result.error}`)
  return result
}

describe('canonicalizeTargetPath', () => {
  it.each([
    // [tail, matched path, forwarded path]
    ['gmail.googleapis.com/gmail/v1/users/me/messages', 'gmail/v1/users/me/messages', 'gmail/v1/users/me/messages'],
    // Calendar ids keep their encoded "@" upstream; matching sees it decoded.
    ['www.googleapis.com/calendar/v3/calendars/me%40example.com/events', 'calendar/v3/calendars/me@example.com/events', 'calendar/v3/calendars/me%40example.com/events'],
    // Interior spaces (Airtable table names) stay encoded upstream.
    ['api.airtable.com/v0/appX/My%20Table', 'v0/appX/My Table', 'v0/appX/My%20Table'],
    // Non-ASCII is encoded by the URL parser and decoded for matching.
    ['api.notion.com/v1/search/été', 'v1/search/été', 'v1/search/%C3%A9t%C3%A9'],
    // A trailing slash is significant (Sentry) and is preserved.
    ['sentry.io/api/0/organizations/acme/', 'api/0/organizations/acme/', 'api/0/organizations/acme/'],
    // Encoded unreserved characters match as their plain form.
    ['gmail.googleapis.com/gmail/v1/users/me/messages/sen%64', 'gmail/v1/users/me/messages/send', 'gmail/v1/users/me/messages/sen%64'],
    // Sub-delimiters and Rest.li syntax are left exactly as sent.
    ['api.linkedin.com/rest/adAccounts/List(urn%3Ali%3AsponsoredAccount%3A1)', 'rest/adAccounts/List(urn:li:sponsoredAccount:1)', 'rest/adAccounts/List(urn%3Ali%3AsponsoredAccount%3A1)'],
    ['docs.googleapis.com/v1/documents/abc:batchUpdate', 'v1/documents/abc:batchUpdate', 'v1/documents/abc:batchUpdate'],
    // A literal percent sign stays escaped in both views.
    ['api.example.com/discounts/100%25', 'discounts/100%25', 'discounts/100%25'],
    // Double encoding is literal text after the one decode servers perform.
    ['api.example.com/notes/%252F', 'notes/%252F', 'notes/%252F'],
    // GitLab reads %2F as data inside one segment: kept encoded in both views.
    ['gitlab.com/api/v4/projects/group%2Fproject/issues', 'api/v4/projects/group%2Fproject/issues', 'api/v4/projects/group%2Fproject/issues'],
    ['gitlab.com/api/v4/projects/1/repository/files/src%2Findex%2Ets/raw', 'api/v4/projects/1/repository/files/src%2Findex.ts/raw', 'api/v4/projects/1/repository/files/src%2Findex%2Ets/raw'],
    // Elsewhere %2F is a separator, as the proxy has always treated it.
    ['api.github.com/repos/o/r/git/ref/heads%2Ffeature', 'repos/o/r/git/ref/heads/feature', 'repos/o/r/git/ref/heads/feature'],
    ['api.example.com', '', ''],
    ['api.example.com/', '', ''],
  ])('accepts %s', (tail, path, encodedPath) => {
    const result = accepted(tail)
    expect(result.path).toBe(path)
    expect(result.encodedPath).toBe(encodedPath)
  })

  it.each([
    // Dot segments in every encoding the matcher would read as text.
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/%252e%252e/messages/send', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/%252E./messages/send', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/.%252e/messages/send', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/%25252e%25252e/messages/send', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/%252e/messages/send', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts%2F..%2Fmessages/send', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/x/%2e%2e%2fsend', '"." or ".." path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/%252e%252e%252Fmessages/send', '"." or ".." path segment'],
    ['gitlab.com/api/v4/projects/group%2F..%2Fother/issues', '"." or ".." path segment'],
    ['gitlab.com/api/v4/projects/group%2F%2E%2E/issues', '"." or ".." path segment'],
    // Backslashes, which URL parsers and some servers read as "/".
    ['gmail.googleapis.com/gmail/v1/users/me/drafts%5C..%5Cmessages%5Csend', 'backslash in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts%5Cmessages/send', 'backslash in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/drafts/%255C..%255Cmessages/send', '"." or ".." path segment'],
    // Query and fragment delimiters smuggled into the path.
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%3F', 'encoded "?" or "#" in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%3Fx=1', 'encoded "?" or "#" in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%23', 'encoded "?" or "#" in a path segment'],
    // Control characters, which URL parsers strip.
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%09', 'control character in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/se%0And', 'control character in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%0D', 'control character in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%00', 'control character in a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%7F', 'control character in a path segment'],
    // Whitespace that a server could trim.
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%20', 'whitespace at the start or end of a path segment'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/%20send', 'whitespace at the start or end of a path segment'],
    // Empty segments, which servers commonly collapse.
    ['gmail.googleapis.com/gmail/v1/users/me/messages//send', 'empty path segment ("//")'],
    ['gmail.googleapis.com//gmail/v1/users/me/messages/send', 'empty path segment ("//")'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages%2F%2Fsend', 'empty path segment ("//")'],
    // Malformed escapes.
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%zz', 'malformed percent-encoding'],
    ['gmail.googleapis.com/gmail/v1/users/me/messages/send%E0%A4%A', 'malformed percent-encoding'],
    // A host segment hiding a separator.
    ['gmail.googleapis.com%2Fgmail/v1/users/me/messages/send', 'the host segment is ambiguously encoded'],
  ])('rejects %s', (tail, error) => {
    const result = canonicalize(tail)
    expect(result).toMatchObject({ ok: false, error })
  })

  it.each([
    'gmail.googleapis.com/gmail/v1/users/me/drafts/../messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/drafts/./messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/drafts/%2E%2E/messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/drafts\\messages\\send',
    'gmail.googleapis.com/gmail/v1/users/me/messages/se\tnd',
    'gmail.googleapis.com/gmail/v1/users/me/messages/se nd',
    'gmail.googleapis.com/gmail/v1/users/me/messages/{send}',
  ])('fails closed on raw input a URL parser would rewrite: %s', (rawTail) => {
    // These never survive request parsing, but the canonicaliser does not
    // rely on that: anything a URL parser would change is rejected.
    const result = canonicalizeTargetPath(rawTail, 'gmail.googleapis.com')
    expect(result.ok).toBe(false)
  })

  it('fails closed when the raw tail does not line up with the parsed host', () => {
    expect(canonicalizeTargetPath('', 'gmail.googleapis.com').ok).toBe(false)
    expect(canonicalizeTargetPath('acc-1/gmail.googleapis.com/x', 'gmail.googleapis.com').ok).toBe(false)
  })

  it('reports the raw path on rejection, for the audit log', () => {
    const result = canonicalize('gmail.googleapis.com/gmail/v1/users/me/drafts/%252e%252e/messages/send')
    expect(result).toMatchObject({ ok: false, rawPath: 'gmail/v1/users/me/drafts/%252e%252e/messages/send' })
  })

  it.each([
    'gmail.googleapis.com/gmail/v1/users/me/messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/drafts/../messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/drafts/%2e%2E/messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/drafts\\..\\messages/send',
    'gmail.googleapis.com/gmail/v1/users/me/messages%2Fsend',
    'gmail.googleapis.com/gmail/v1/users/me/messages/sen%64',
    'www.googleapis.com/calendar/v3/calendars/me%40example.com/events',
    'api.airtable.com/v0/appX/My%20Table/rec1',
    'api.notion.com/v1/search/été',
    'api.example.com/notes/%252F/%2525',
    'gitlab.com/api/v4/projects/group%2Fproject/issues',
    'sentry.io/api/0/organizations/acme/',
  ])('upstream parses the forwarded URL to the path that was matched: %s', (tail) => {
    const { host, path, encodedPath } = accepted(tail)
    const upstream = new URL(`https://${host}/${encodedPath}?q=1`)
    expect(upstream.host).toBe(host)
    expect(upstream.pathname).toBe(`/${encodedPath}`)
    expect(upstream.search).toBe('?q=1')
    // Canonicalising what upstream parsed yields the same matched path.
    expect(canonicalizeTargetPath(`${host}${upstream.pathname}`, host)).toEqual({ ok: true, path, encodedPath })
  })
})

describe('rawRouteTail', () => {
  it('returns the tail exactly as encoded in the request URL', () => {
    expect(rawRouteTail('http://localhost/api/proxy/a/acc/gitlab.com/x%2Fy/z%20w?q=%2F', ROUTE, 'rest'))
      .toBe('gitlab.com/x%2Fy/z%20w')
  })

  it('works for a route mounted at the root', () => {
    expect(rawRouteTail('http://localhost/a/acc/host/x%2Fy', '/:agentSlug/:accountId/:rest{.+}', 'rest'))
      .toBe('host/x%2Fy')
  })

  it('fails closed on an unknown param or an unreadable URL', () => {
    expect(rawRouteTail('http://localhost/api/proxy/a/acc/host/x', ROUTE, 'other')).toBe('')
    expect(rawRouteTail('not a url', ROUTE, 'rest')).toBe('')
  })
})
