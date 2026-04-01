/**
 * Browser Use Permission & Request Types
 *
 * Four permission levels control what agents can do in the browser:
 * - browse_read: passive observation (snapshot, screenshot, get_state, wait) — domain-scoped
 * - browse_interact: page interaction (click, fill, scroll, press, select, hover) — domain-scoped
 * - browse_navigate: open/navigate to URLs — domain-scoped (target URL)
 * - browse_manage: lifecycle & advanced (close, run arbitrary commands) — global (not domain-scoped)
 */

export type { PermissionGrantType } from '@shared/lib/permissions/types'
export { TIMED_GRANT_DURATION_MS } from '@shared/lib/permissions/types'

export type BrowserUsePermissionLevel =
  | 'browse_read'
  | 'browse_interact'
  | 'browse_navigate'
  | 'browse_manage'

/** Persisted in settings.json — only 'always' grants are stored */
export interface BrowserUseSettings {
  agentPermissions?: Record<string, {
    grants: Array<{
      level: BrowserUsePermissionLevel
      domain?: string
      grantType: 'always'
    }>
  }>
}

/** SSE event broadcast when a browser use request needs user approval */
export interface BrowserUseRequestEvent {
  type: 'browser_use_request'
  toolUseId: string
  method: string
  params: Record<string, unknown>
  permissionLevel: BrowserUsePermissionLevel
  domain?: string
  agentSlug?: string
}

/** Browser methods that only need browse_read permission */
export const READ_ONLY_BROWSER_METHODS = new Set([
  'snapshot', 'screenshot', 'get_state', 'wait',
])

/** Browser methods that need browse_interact permission */
export const INTERACT_BROWSER_METHODS = new Set([
  'click', 'fill', 'scroll', 'press', 'select', 'hover',
])

/** Browser methods that need browse_navigate permission */
export const NAVIGATE_BROWSER_METHODS = new Set([
  'open',
])

/** Browser methods that need browse_manage permission (not domain-scoped) */
export const MANAGE_BROWSER_METHODS = new Set([
  'close', 'run',
])

/** Permission levels that are scoped to a domain */
export const DOMAIN_SCOPED_LEVELS = new Set<BrowserUsePermissionLevel>([
  'browse_read', 'browse_interact', 'browse_navigate',
])

/**
 * Determine the permission level required for a browser method.
 */
export function getRequiredBrowserPermissionLevel(method: string): BrowserUsePermissionLevel {
  if (READ_ONLY_BROWSER_METHODS.has(method)) return 'browse_read'
  if (INTERACT_BROWSER_METHODS.has(method)) return 'browse_interact'
  if (NAVIGATE_BROWSER_METHODS.has(method)) return 'browse_navigate'
  return 'browse_manage'
}

/**
 * Extract the domain from a URL string.
 * Returns undefined if the URL is invalid or has no hostname.
 */
export function extractDomainFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.hostname || undefined
  } catch {
    return undefined
  }
}

/**
 * Check if a requested domain matches a grant domain.
 *
 * - Wildcard grant (undefined, '*', or '') matches any domain.
 * - Exact match: 'github.com' matches 'github.com'
 * - Subdomain match: grant for 'github.com' also matches 'docs.github.com'
 */
export function domainMatches(grantDomain: string | undefined, requestedDomain: string | undefined): boolean {
  // Wildcard grant matches anything
  if (!grantDomain || grantDomain === '*') return true
  // No requested domain — only wildcard grants match
  if (!requestedDomain) return false

  const grantLower = grantDomain.toLowerCase()
  const requestedLower = requestedDomain.toLowerCase()

  // Exact match
  if (requestedLower === grantLower) return true
  // Subdomain match: requested ends with ".grantDomain"
  if (requestedLower.endsWith('.' + grantLower)) return true

  return false
}
