// The platform's OIDC issuer namespaces its custom id_token claims under one
// URL (PLATFORM_CLAIMS in the platform's apps/auth/src/oidc/account.ts).
const NAMESPACE = 'https://platform.skillfulagents.dev/claims'

export const PLATFORM_CLAIMS = {
  orgId: `${NAMESPACE}/org_id`,
  role: `${NAMESPACE}/role`,
  userId: `${NAMESPACE}/user_id`,
} as const
