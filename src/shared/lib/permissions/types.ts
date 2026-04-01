/**
 * Shared Permission Types
 *
 * Common types used by both computer use and browser use permission systems.
 */

export type PermissionGrantType = 'once' | 'timed' | 'always'

/** Duration of "timed" permission grants in milliseconds (15 minutes) */
export const TIMED_GRANT_DURATION_MS = 15 * 60 * 1000

export interface PermissionGrant<TLevel extends string> {
  level: TLevel
  /** Scope identifier — appName for computer use, domain for browser use */
  scope?: string
  grantType: PermissionGrantType
  grantedAt: number
  /** Only for 'timed' grants */
  expiresAt?: number
}
