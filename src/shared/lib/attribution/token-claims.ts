/**
 * Returns the orgId claim if the token is an org-scoped JWT, else null.
 * Acts as the discriminator between org tokens (need X-Platform-Member-Id
 * header) and opaque access keys (proxy reads memberId from the DB row).
 */
export function decodeOrgIdFromToken(token: string): string | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  try {
    const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as { orgId?: unknown }
    return typeof parsed.orgId === 'string' && parsed.orgId.length > 0 ? parsed.orgId : null
  } catch {
    return null
  }
}
