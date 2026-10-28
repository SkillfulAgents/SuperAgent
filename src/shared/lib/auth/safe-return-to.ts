// Validate a relative in-app return path for the Platform SSO launcher.
// Rejects open redirects (absolute, protocol-relative, encoded separators).
export function sanitizeReturnTo(raw: string | null | undefined, fallback = '/'): string {
  if (raw == null || raw === '') return fallback

  let value = raw.trim()
  try {
    value = decodeURIComponent(value)
  } catch {
    return fallback
  }

  if (!value.startsWith('/')) return fallback
  if (value.startsWith('//')) return fallback
  if (value.includes('\\')) return fallback
  if (value.includes('://')) return fallback
  if (/[\r\n\0]/.test(value)) return fallback

  return value
}
