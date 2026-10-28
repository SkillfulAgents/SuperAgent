// Dependency-free org-id decode, standalone to avoid an import cycle
// (provider-config <- platform-attribution <- platform-auth-service).

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4)
  return Buffer.from(padded, 'base64').toString('utf8')
}

/** Unverified `orgId` claim, or null for opaque access keys. Used only for routing. */
export function decodeOrgIdFromToken(token: string): string | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null
  try {
    const claims = JSON.parse(decodeBase64Url(segments[1])) as { orgId?: unknown }
    return typeof claims.orgId === 'string' && claims.orgId.length > 0 ? claims.orgId : null
  } catch {
    return null
  }
}
