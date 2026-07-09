import { NonRetryableError } from '../utils/retry'

/**
 * Map a proxy error from a platform web call to an actionable, remediation-pointing message.
 * The provider pre-guards an ABSENT token, so at this point a token was sent and the proxy rejected
 * it. Each status carries a DIFFERENT remedy, and telling a user to do the wrong one is worse than
 * saying nothing, so they do not share copy (proxy: apps/proxy/src/auth.ts, billing/gate.ts):
 *
 *   401 — token expired / invalid / revoked / superseded  -> signing in again fixes it
 *   403 — trial ended / member inactive / wrong org        -> signing in again does NOT fix it
 *   402 — blocked / past due / insufficient balance        -> billing fixes it
 *
 * Each message names where to fix it (the Web provider setting), since a failed search/fetch is the
 * user's only touchpoint. Any other error passes through unchanged.
 */
export function mapPlatformWebError(err: unknown, surface: 'search' | 'fetch'): unknown {
  if (err instanceof NonRetryableError) {
    if (err.status === 401) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut session has expired or is invalid. Sign in again, or pick a different provider under the Web provider setting in Settings.`,
      )
    }
    if (err.status === 403) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut account does not have access to it (the trial may have ended, or the membership is inactive). Check your account, or pick a different provider under the Web provider setting in Settings.`,
      )
    }
    if (err.status === 402) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut account has a billing issue. Resolve billing, or switch to Native or Exa under the Web provider setting in Settings.`,
      )
    }
  }
  return err
}
