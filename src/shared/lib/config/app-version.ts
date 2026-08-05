/** Strip a leading `v` so `v0.5.0` and `0.5.0` compare equal. */
export function normalizeAppVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/** Display form with a single leading `v`. */
export function formatAppVersion(version: string): string {
  const normalized = normalizeAppVersion(version)
  return normalized ? `v${normalized}` : ''
}
