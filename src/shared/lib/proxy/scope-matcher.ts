import { Kind, parse, type OperationDefinitionNode } from 'graphql'
import { SCOPE_MAPS, parseBorrowedScope, type ScopeMapEntry } from './scope-maps'
import { PARSE_MAX_BYTES, isGraphqlRequest } from './review-display'
import { getScopeDescription } from './scope-metadata'
import { ACCOUNT_DEFAULT_SCOPE, isLabelDefaultKey } from './policy-sentinels'

export interface ScopeMatchResult {
  matched: boolean
  scopes: string[]
  /**
   * Curated per-scope descriptions describing what each scope GRANTS.
   * Used in "Always allow <scope>" menu items and the settings dialog.
   */
  descriptions: Record<string, string>
  /**
   * Description of the matched API endpoint (what the current call DOES).
   * Used to render the prompt headline so the user sees the immediate action,
   * not a broader scope-level summary that may be alarming.
   */
  endpointDescription?: string
  /** Equally specific endpoints disagree on what the call does, so none is named. */
  endpointAmbiguous?: boolean
}

/**
 * Is `scope` a legal API scope policy key for `toolkit`?
 *
 * True for the reserved policy sentinels — the account default ('*') and the
 * per-risk-label defaults ('*read'/'*write'/'*destructive'), which are valid on
 * any toolkit (the in-session "Allow all <label>" action routes them through
 * the proxy-review /always endpoint) — or a scope the toolkit actually declares
 * in its scope map. Used to reject garbage or smuggled scopes before they are
 * persisted as a policy. An unknown toolkit has no known scope set, so only
 * sentinels are accepted for it.
 */
export function isValidApiScope(toolkit: string | undefined, scope: unknown): boolean {
  if (typeof scope !== 'string' || scope.length === 0) return false
  if (scope === ACCOUNT_DEFAULT_SCOPE || isLabelDefaultKey(scope)) return true
  if (!toolkit) return false
  const borrowed = parseBorrowedScope(toolkit, scope)
  if (borrowed) return declaresScope(borrowed.provider, borrowed.scope)
  return declaresScope(toolkit, scope)
}

function declaresScope(toolkit: string, scope: string): boolean {
  const provider = SCOPE_MAPS[toolkit]
  if (!provider) return false
  const all = Array.isArray(provider.allScopes)
    ? provider.allScopes
    : Object.values(provider.allScopes).flat()
  return all.includes(scope)
}

/**
 * Match a request against scope maps to determine which scopes apply.
 * Pure function — no DB or side effects.
 *
 * When the toolkit's own map has no entry, each provider in its
 * `scopeFallbacks` is tried, but only if that provider's `apiHost` is the
 * request's `targetHost` (compared without case, as the proxy accepts any
 * case). Borrowed scopes are returned as `<provider>:<scope>`
 * so a policy on the toolkit's own scope of the same name never covers them;
 * their risk label is the fallback provider's (see getScopeLabel).
 */
export function matchScopes(
  toolkit: string,
  method: string,
  targetPath: string,
  targetHost?: string,
  body?: ArrayBuffer | null,
): ScopeMatchResult {
  const empty: ScopeMatchResult = { matched: false, scopes: [], descriptions: {}, endpointDescription: undefined }

  const own = matchProvider(toolkit, method, targetPath, body)
  if (own) return own
  if (!targetHost) return empty

  for (const fallback of SCOPE_MAPS[toolkit]?.scopeFallbacks ?? []) {
    if (SCOPE_MAPS[fallback]?.apiHost !== targetHost.toLowerCase()) continue
    const borrowed = matchProvider(fallback, method, targetPath, body)
    if (!borrowed) continue
    const scopes = borrowed.scopes.map((s) => `${fallback}:${s}`)
    const descriptions: Record<string, string> = {}
    for (const s of borrowed.scopes) {
      if (borrowed.descriptions[s]) descriptions[`${fallback}:${s}`] = borrowed.descriptions[s]
    }
    return { ...borrowed, scopes, descriptions }
  }

  return empty
}

function matchProvider(
  toolkit: string,
  method: string,
  targetPath: string,
  body?: ArrayBuffer | null,
): ScopeMatchResult | null {
  const provider = SCOPE_MAPS[toolkit]
  if (!provider) return null

  // Normalize
  const normalizedMethod = method.toUpperCase()
  let normalizedPath = targetPath
  if (!normalizedPath || normalizedPath.trim() === '') return null
  if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath

  // Filter by method. An entry with method "*" is method-agnostic and matches
  // any HTTP verb — used for RPC-style APIs (e.g. Slack) where the path alone
  // identifies the operation and the same scope applies whether the agent calls
  // it via GET or POST.
  const methodMatches = provider.scopeMap.filter(
    (entry) => entry.method === '*' || entry.method === normalizedMethod
  )

  // Glob-match each entry's pathPattern against the target path
  type ScoredMatch = { entry: ScopeMapEntry; wildcardScore: number }
  const matches: ScoredMatch[] = []

  for (const entry of methodMatches) {
    const wildcardScore = globMatch(entry.pathPattern, normalizedPath)
    if (wildcardScore !== null) {
      matches.push({ entry, wildcardScore })
    }
  }

  if (matches.length === 0) return null

  // Keep the most specific matches (lowest wildcard score)
  const minWildcardScore = Math.min(...matches.map((m) => m.wildcardScore))
  let bestMatches = matches.filter((m) => m.wildcardScore === minWildcardScore)
  // GraphQL providers list each operation on one path, described by its root field.
  const graphqlField = body && bestMatches.length > 1 ? graphqlRootField(body) : undefined
  const fieldMatches = graphqlField
    ? bestMatches.filter((m) => m.entry.description?.startsWith(`${graphqlField} `))
    : []
  if (fieldMatches.length > 0) bestMatches = fieldMatches

  // Collect union of scopes and descriptions
  const scopeSet = new Set<string>()
  const descriptions: Record<string, string> = {}

  for (const { entry } of bestMatches) {
    for (const scope of entry.sufficientScopes) {
      scopeSet.add(scope)
      if (scope in descriptions) continue
      // Prefer the curated per-scope description; fall back to the
      // matched endpoint description so we don't regress on scopes
      // that are not yet curated.
      const curated = getScopeDescription(toolkit, scope)
      if (curated) {
        descriptions[scope] = curated
      } else if (entry.description) {
        descriptions[scope] = entry.description
      }
    }
  }

  return {
    matched: true,
    scopes: Array.from(scopeSet),
    descriptions,
    ...describeTie(bestMatches.map((m) => m.entry)),
  }
}

/**
 * What equally specific endpoints say the call does: one description when they agree, none when they
 * disagree (RPC-style providers like Linear and Monday). A literal last segment names the call more
 * precisely, as Salesforce's describe path over its record-by-id path. Wording only: the scopes stay the union.
 */
export function describeTie(entries: ScopeMapEntry[]): Pick<ScopeMatchResult, 'endpointDescription' | 'endpointAmbiguous'> {
  const literalLast = entries.filter((e) => !e.pathPattern.slice(e.pathPattern.lastIndexOf('/') + 1).includes('*'))
  const descriptions = new Set((literalLast.length > 0 ? literalLast : entries).flatMap((e) => e.description ?? []))
  if (descriptions.size > 1) return { endpointDescription: undefined, endpointAmbiguous: true }
  return { endpointDescription: [...descriptions][0] }
}

/**
 * The one root field a GraphQL request runs, keyed as the scope map describes it (`Mutation: issueDelete`).
 * Undefined unless the body selects exactly one field of the operation the server runs. Aliases are ignored.
 */
export function graphqlRootField(body: ArrayBuffer): string | undefined {
  if (body.byteLength > PARSE_MAX_BYTES) return undefined
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!isGraphqlRequest(json)) return undefined
    const operationName = typeof json.operationName === 'string' ? json.operationName : undefined
    const operations = parse(json.query).definitions
      .filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
      .filter((o) => operationName === undefined || o.name?.value === operationName)
    const operation = operations.length === 1 ? operations[0] : undefined
    const field = operation?.selectionSet.selections.length === 1 ? operation.selectionSet.selections[0] : undefined
    if (!operation || field?.kind !== Kind.FIELD) return undefined
    return `${operation.operation[0].toUpperCase()}${operation.operation.slice(1)}: ${field.name.value}`
  } catch {
    return undefined
  }
}

/**
 * Glob-match a path pattern against a target path.
 * Returns a wildcard specificity score, or null if no match.
 *
 * Rules:
 *  - Split both by '/', compare segment-by-segment
 *  - '*' matches one or more characters within a single segment
 *  - Segments without wildcards must match exactly
 */
function globMatch(pattern: string, path: string): number | null {
  const patternSegs = pattern.replace(/^\//, '').split('/')
  const pathSegs = path.replace(/^\//, '').split('/')

  if (patternSegs.length !== pathSegs.length) return null

  let wildcardScore = 0
  for (let i = 0; i < patternSegs.length; i++) {
    const patternSegment = patternSegs[i]
    const pathSegment = pathSegs[i]

    if (!patternSegment.includes('*')) {
      if (patternSegment !== pathSegment) return null
      continue
    }

    const expression = patternSegment
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+')
    if (!new RegExp(`^${expression}$`).test(pathSegment)) return null

    wildcardScore += patternSegment === '*' ? 2 : 1
  }

  return wildcardScore
}
