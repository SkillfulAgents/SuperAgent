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
 */

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export interface ParsedApiPattern {
  method: string
  segments: string[]
}

export type PatternParseResult =
  | { ok: true; pattern: ParsedApiPattern }
  | { ok: false; error: string }

export function parseApiPattern(raw: string): PatternParseResult {
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

function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes('*')) return pattern === segment
  if (segment === '') return false
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+')
  return new RegExp(`^${expression}$`).test(segment)
}

function segmentsMatch(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0
  const [head, ...rest] = pattern
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip++) {
      if (segmentsMatch(rest, path.slice(skip))) return true
    }
    return false
  }
  if (path.length === 0) return false
  return segmentMatches(head, path[0]) && segmentsMatch(rest, path.slice(1))
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
  const trimmed = raw.trim()
  if (trimmed === '') return 'Tool pattern must not be empty'
  if (/\s/.test(trimmed)) return `Tool pattern "${raw}" must not contain whitespace`
  return null
}

export function matchesToolPattern(pattern: string, toolName: string): boolean {
  const expression = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${expression}$`).test(toolName)
}

export function matchesAnyToolPattern(patterns: string[], toolName: string): boolean {
  return patterns.some((pattern) => validateToolPattern(pattern) === null && matchesToolPattern(pattern, toolName))
}

/** True when any segment of the path is `.` or `..`. */
export function hasDotSegment(path: string): boolean {
  return splitPath(path).some((segment) => segment === '.' || segment === '..')
}
