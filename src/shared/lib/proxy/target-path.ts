/**
 * Canonical form of the `<path>` in an API proxy URL
 * (`/api/proxy/<agent>/<account>/<host>/<path>`).
 *
 * The policy check and the upstream request must agree on which endpoint a
 * call reaches. Hono hands the route a fully percent-decoded param, and the
 * forwarded URL is parsed again by `fetch`, so a path built from the decoded
 * param can read one way to the scope matcher and another way upstream. This
 * module derives the path once, from the raw request URL, and returns two
 * views of the same segments:
 *
 *  - `encodedPath`: forwarded upstream. A URL parser leaves it unchanged:
 *    `new URL('https://<host>/' + encodedPath).pathname === '/' + encodedPath`.
 *  - `path`: what scope matching, review prompts and the audit log see. Each
 *    segment is percent-decoded once, then `%` and `/` are re-escaped, so a
 *    segment boundary is always a real separator.
 *
 * Rules:
 *  - Rejected: a `.` or `..` segment in any encoding (`%2e`, mixed case, behind
 *    an encoded slash, or double-encoded as `%252e`: a single decode makes that
 *    the literal text `%2e`, but some servers decode twice and no API needs
 *    it); backslashes (`\`, `%5C`); control characters; `?` or `#` (`%3F`,
 *    `%23`); whitespace at either end of a segment; empty segments (`a//b`, a
 *    leading `/`); malformed percent-encoding; anything a URL parser would
 *    rewrite.
 *  - Encoded slashes (`%2F`) are separators, decoded to `/` before matching
 *    and forwarding (how the proxy has always treated them), except on hosts
 *    whose API takes them as data inside one segment (GitLab's
 *    `projects/group%2Fproject`), where they stay encoded in both views.
 *  - Everything else is forwarded exactly as the client encoded it: `%20`,
 *    `%40`, UTF-8, a trailing slash.
 */

export type TargetPath =
  | { ok: true; path: string; encodedPath: string }
  | { ok: false; error: string; rawPath: string }

/** Hosts whose API reads `%2F` as data within a segment, not as a separator. */
const ENCODED_SLASH_HOSTS = new Set(['gitlab.com'])

/** Decoding rounds checked for hidden dot segments (`%252e` needs two). */
const DOT_SEGMENT_DECODE_DEPTH = 3

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** True if `raw`, or any of its first few decodings, contains a dot segment. */
function hidesDotSegment(raw: string): boolean {
  let value: string | null = raw
  for (let depth = 0; value !== null && depth <= DOT_SEGMENT_DECODE_DEPTH; depth++) {
    if (value.split(/[/\\]/).some((part) => part === '.' || part === '..')) return true
    const next = decodeOnce(value)
    if (next === value) return false
    value = next
  }
  return false
}

function segmentError(raw: string, decoded: string): string | null {
  if (hasControlCharacter(decoded)) return 'control character in a path segment'
  if (decoded.includes('\\')) return 'backslash in a path segment'
  if (decoded.includes('?') || decoded.includes('#')) return 'encoded "?" or "#" in a path segment'
  if (/^\s|\s$/.test(decoded)) return 'whitespace at the start or end of a path segment'
  if (hidesDotSegment(raw)) return '"." or ".." path segment'
  return null
}

function isStableUrlPath(encodedPath: string): boolean {
  try {
    return new URL(`https://proxy.invalid/${encodedPath}`).pathname === `/${encodedPath}`
  } catch {
    return false
  }
}

/**
 * Canonicalise a proxy target path.
 *
 * `rawTail` is `<host>[/<path>]` exactly as it appears in the request URL's
 * pathname (see rawRouteTail). `targetHost` is the host the route parsed from
 * the decoded param; the raw host segment must decode to exactly that, so the
 * route and this module agree on where the path starts.
 */
export function canonicalizeTargetPath(rawTail: string, targetHost: string): TargetPath {
  const slash = rawTail.indexOf('/')
  const rawHost = slash === -1 ? rawTail : rawTail.slice(0, slash)
  const rawPath = slash === -1 ? '' : rawTail.slice(slash + 1)
  const fail = (error: string): TargetPath => ({ ok: false, error, rawPath })

  if (decodeOnce(rawHost) !== targetHost) return fail('the host segment is ambiguously encoded')
  if (rawPath === '') return { ok: true, path: '', encodedPath: '' }

  const keepEncodedSlash = ENCODED_SLASH_HOSTS.has(targetHost.toLowerCase())
  const rawSegments = rawPath.split(keepEncodedSlash ? '/' : /\/|%2F/i)
  const segments: string[] = []

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i]
    if (raw === '') {
      // A trailing slash is significant to some APIs (Sentry); any other
      // empty segment is one that servers commonly collapse.
      if (i === rawSegments.length - 1) {
        segments.push('')
        continue
      }
      return fail('empty path segment ("//")')
    }
    const decoded = decodeOnce(raw)
    if (decoded === null) return fail('malformed percent-encoding')
    const error = segmentError(raw, decoded)
    if (error) return fail(error)
    segments.push(decoded)
  }

  const encodedPath = rawSegments.join('/')
  if (!isStableUrlPath(encodedPath)) return fail('the path is not in canonical URL form')

  const path = segments
    .map((segment) => segment.replace(/%/g, '%25').replace(/\//g, '%2F'))
    .join('/')
  return { ok: true, path, encodedPath }
}

/**
 * The part of `requestUrl`'s path matched by the route's `:<param>` tail
 * pattern, exactly as the client encoded it. Hono's params are decoded, which
 * loses whether a "/" was literal or `%2F`; the raw URL keeps it. Raw segments
 * line up with the route's because Hono routes on a path that never decodes
 * `%2F`. Returns '' if the URL or pattern can't be read (callers fail closed).
 */
export function rawRouteTail(requestUrl: string, routePattern: string, param: string): string {
  const index = routePattern.split('/').findIndex((segment) => segment.startsWith(`:${param}`))
  if (index === -1) return ''
  try {
    return new URL(requestUrl).pathname.split('/').slice(index).join('/')
  } catch {
    return ''
  }
}
