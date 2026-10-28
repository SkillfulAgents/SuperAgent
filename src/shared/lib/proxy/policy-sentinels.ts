/**
 * Reserved sentinel values stored in the apiScopePolicies.scope column.
 *
 * That column holds either a real provider scope, or one of these reserved keys
 * representing a default that applies to a group of scopes:
 *   '*'                                  — account-wide default (any scope without
 *                                          a more specific policy)
 *   '*read' / '*write' / '*destructive'  — per-risk-label default for this account
 *                                          (written only when the user saves them
 *                                          in the scope policy editor)
 *
 * A leading '*' cannot collide with a real provider scope — provider scopes are
 * dotted/colon identifiers (e.g. "data.records:write") and never begin with '*'.
 */
import type { ScopeLabel } from './scope-metadata'

export const ACCOUNT_DEFAULT_SCOPE = '*'

/** The reserved scope key for a given risk label's account-wide default. */
export function labelDefaultKey(label: ScopeLabel): string {
  return `*${label}`
}

export function isLabelDefaultKey(
  scope: string,
): scope is '*read' | '*write' | '*destructive' {
  return scope === '*read' || scope === '*write' || scope === '*destructive'
}

/**
 * Recommended per-label defaults. The scope policy editor pre-fills these for an
 * unconfigured account so the user sees a sensible starting point, but they are
 * persisted ONLY when the user clicks Save. This is NOT a live resolution fallback:
 * an account with no saved '*read'/'*write'/'*destructive' rows skips the label tier
 * entirely and resolves via the account '*' default → global default.
 */
export const LABEL_DEFAULT_BASELINE: Record<
  ScopeLabel,
  'allow' | 'review' | 'block'
> = {
  read: 'allow',
  write: 'review',
  destructive: 'block',
}
