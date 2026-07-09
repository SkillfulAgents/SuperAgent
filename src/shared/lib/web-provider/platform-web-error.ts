import { NonRetryableError } from '../utils/retry'

/**
 * Map a proxy error from a platform web call to an actionable, remediation-pointing message.
 * The provider pre-guards an ABSENT token, so at this point a token was sent and the proxy rejected
 * it: 401/403 means the Gamut session is expired/revoked, 402 means a billing block. Both messages
 * name where to fix it (the Web provider setting), since a failed search/fetch is the user's only
 * touchpoint. Any other error passes through unchanged.
 */
export function mapPlatformWebError(err: unknown, surface: 'search' | 'fetch'): unknown {
  if (err instanceof NonRetryableError) {
    if (err.status === 401 || err.status === 403) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut session has expired or is invalid. Sign in again, or pick a different provider under the Web provider setting in Settings.`,
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
