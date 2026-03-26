import { SCOPE_MAPS, type ScopeMapEntry } from './scope-maps'

export interface ScopeMatchResult {
  matched: boolean
  scopes: string[]
  descriptions: Record<string, string>
}

/**
 * Match a request against scope maps to determine which scopes apply.
 * Pure function — no DB or side effects.
 */
export function matchScopes(
  toolkit: string,
  method: string,
  targetPath: string
): ScopeMatchResult {
  const empty: ScopeMatchResult = { matched: false, scopes: [], descriptions: {} }

  const provider = SCOPE_MAPS[toolkit]
  if (!provider) return empty

  // Normalize
  const normalizedMethod = method.toUpperCase()
  let normalizedPath = targetPath
  if (!normalizedPath || normalizedPath.trim() === '') return empty
  if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath

  // Filter by method
  const methodMatches = provider.scopeMap.filter(
    (entry) => entry.method === normalizedMethod
  )

  // Glob-match each entry's pathPattern against the target path
  type ScoredMatch = { entry: ScopeMapEntry; wildcardCount: number }
  const matches: ScoredMatch[] = []

  for (const entry of methodMatches) {
    const wc = globMatch(entry.pathPattern, normalizedPath)
    if (wc !== null) {
      matches.push({ entry, wildcardCount: wc })
    }
  }

  if (matches.length === 0) return empty

  // Keep the most specific matches (fewest wildcards)
  const minWildcards = Math.min(...matches.map((m) => m.wildcardCount))
  const bestMatches = matches.filter((m) => m.wildcardCount === minWildcards)

  // Collect union of scopes and descriptions
  const scopeSet = new Set<string>()
  const descriptions: Record<string, string> = {}

  for (const { entry } of bestMatches) {
    const desc = entry.description ?? ''
    for (const scope of entry.sufficientScopes) {
      scopeSet.add(scope)
      // First description wins per scope
      if (!(scope in descriptions) && desc) {
        descriptions[scope] = desc
      }
    }
  }

  return {
    matched: true,
    scopes: Array.from(scopeSet),
    descriptions,
  }
}

/**
 * Glob-match a path pattern against a target path.
 * Returns the number of wildcard segments used, or null if no match.
 *
 * Rules:
 *  - Split both by '/', compare segment-by-segment
 *  - '*' matches any single non-empty segment
 *  - Segments must match exactly otherwise
 */
function globMatch(pattern: string, path: string): number | null {
  // Normalize leading slashes
  const patternSegs = pattern.replace(/^\//, '').split('/')
  const pathSegs = path.replace(/^\//, '').split('/')

  if (patternSegs.length !== pathSegs.length) return null

  let wildcardCount = 0
  for (let i = 0; i < patternSegs.length; i++) {
    if (patternSegs[i] === '*') {
      if (!pathSegs[i]) return null // * must match non-empty
      wildcardCount++
    } else if (patternSegs[i] !== pathSegs[i]) {
      return null
    }
  }

  return wildcardCount
}
