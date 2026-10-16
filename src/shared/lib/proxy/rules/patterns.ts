/**
 * Endpoint patterns that decide which requests a proxy rule sees.
 *
 * API rules use `METHOD /path` strings:
 *   - METHOD is an HTTP verb or `*` (any verb).
 *   - Path segments are literals, `*` (exactly one segment; may be partial,
 *     e.g. `msg*`, same as the scope maps) or `**` (zero or more segments).
 *   - The query string is never matched — the rule receives it as input.
 *
 * MCP rules use tool-name globs (`requestSendMoney`, `notion-update-*`), where
 * `*` matches any run of characters.
 *
 * Patterns are matched against the path exactly as the proxy forwards it; the
 * proxy rejects dot segments before rules run, so the two cannot diverge.
 *
 * Matching runs on the app's thread, outside the rule sandbox, on paths and
 * tool names the agent chooses — so it never uses regular expressions (whose
 * backtracking a pattern like `*a*a*a*b` can make exponential): globs match
 * with a greedy left-to-right scan, and `**` with a pattern × path table.
 */

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const MAX_PATTERN_LENGTH = 512

export interface ParsedApiPattern {
  method: string
  segments: string[]
}

export type PatternParseResult =
  | { ok: true; pattern: ParsedApiPattern }
  | { ok: false; error: string }

export function parseApiPattern(raw: string): PatternParseResult {
  if (raw.length > MAX_PATTERN_LENGTH) return { ok: false, error: `Patterns must be at most ${MAX_PATTERN_LENGTH} characters` }
  const trimmed = raw.trim()
  const match = /^(\S+)\s+(\/\S*)$/.exec(trimmed)
  if (!match) return { ok: false, error: `"${raw}" is not "METHOD /path"` }
  const method = match[1].toUpperCase()
  if (method !== '*' && !HTTP_METHODS.has(method)) {
    return { ok: false, error: `"${match[1]}" is not an HTTP method or *` }
  }
  const path = match[2]
  if (path.includes('?') || path.includes('#')) {
    return { ok: false, error: `"${raw}" must not include a query string or fragment` }
  }
  const segments = splitPath(path)
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, error: `"${raw}" must not contain dot segments` }
    }
    if (segment.includes('**') && segment !== '**') {
      return { ok: false, error: `"**" must be a whole path segment in "${raw}"` }
    }
  }
  return { ok: true, pattern: { method, segments } }
}

function splitPath(path: string): string[] {
  const stripped = path.replace(/^\/+/, '')
  return stripped === '' ? [] : stripped.split('/')
}

/**
 * Glob match where each `*` stands for at least `starMin` characters. The
 * literal parts between stars are placed left to right at their earliest
 * position, which is optimal for globs without other wildcards, so the cost
 * is one `indexOf` per part — no backtracking.
 */
export function globMatches(pattern: string, text: string, starMin: 0 | 1): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return pattern === text
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!text.startsWith(first)) return false
  let cursor = first.length
  for (let i = 1; i < parts.length - 1; i++) {
    const at = text.indexOf(parts[i], cursor + starMin)
    if (at === -1) return false
    cursor = at + parts[i].length
  }
  return text.length - last.length >= cursor + starMin && text.endsWith(last)
}

function segmentMatches(pattern: string, segment: string): boolean {
  return globMatches(pattern, segment, 1)
}

/**
 * Pattern segments against path segments; `**` spans zero or more. Filled
 * bottom-up (no recursion, so no stack depth to exhaust): `next[q]` says
 * whether pattern[p + 1..] matches path[q..]. Cost is pattern × path segment
 * comparisons.
 */
function segmentsMatch(pattern: string[], path: string[]): boolean {
  const n = path.length
  let next: boolean[] = Array.from({ length: n + 1 }, (_, q) => q === n)
  for (let p = pattern.length - 1; p >= 0; p--) {
    const current: boolean[] = new Array(n + 1).fill(false)
    for (let q = n; q >= 0; q--) {
      current[q] = pattern[p] === '**'
        ? next[q] || (q < n && current[q + 1])
        : q < n && next[q + 1] && segmentMatches(pattern[p], path[q])
    }
    next = current
  }
  return next[0]
}

export function matchesApiPattern(pattern: ParsedApiPattern, method: string, path: string): boolean {
  if (pattern.method !== '*' && pattern.method !== method.toUpperCase()) return false
  return segmentsMatch(pattern.segments, splitPath(path))
}

export function matchesAnyApiPattern(patterns: string[], method: string, path: string): boolean {
  return patterns.some((raw) => {
    const parsed = parseApiPattern(raw)
    return parsed.ok && matchesApiPattern(parsed.pattern, method, path)
  })
}

export function validateToolPattern(raw: string): string | null {
  if (raw.length > MAX_PATTERN_LENGTH) return `Tool patterns must be at most ${MAX_PATTERN_LENGTH} characters`
  const trimmed = raw.trim()
  if (trimmed === '') return 'Tool pattern must not be empty'
  if (/\s/.test(trimmed)) return `Tool pattern "${raw}" must not contain whitespace`
  return null
}

export function matchesToolPattern(pattern: string, toolName: string): boolean {
  return globMatches(pattern.trim(), toolName, 0)
}

export function matchesAnyToolPattern(patterns: string[], toolName: string): boolean {
  return patterns.some((pattern) => validateToolPattern(pattern) === null && matchesToolPattern(pattern, toolName))
}

/** True when any segment of the path is `.` or `..`. */
export function hasDotSegment(path: string): boolean {
  return splitPath(path).some((segment) => segment === '.' || segment === '..')
}
