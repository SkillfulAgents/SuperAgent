import { z } from 'zod'

// RFC 7523 JWT bearer authorization grant URN (RFC 7523 §2.1).
export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

// Explicit token type for the platform-issued JWT authorization grant.
// Distinct from `PLATFORM_TOKEN` org JWTs (typ JWT, aud platform-org-runtime)
// so the two can never be confused.
export const DEPLOYMENT_ASSERTION_TYP = 'deployment-assertion+jwt'

// Grants must be short-lived; reject anything expiring further out than this.
export const MAX_GRANT_LIFETIME_SEC = 300

// Decoded JWT authorization-grant payload, validated after JOSE signature
// verification. jose already enforced iss/aud/exp; this pins the shape of
// everything the exchange logic consumes.
export const DeploymentGrantClaimsSchema = z
  .object({
    iss: z.string().min(1),
    sub: z.string().min(1).max(256),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(1).max(256),
    org_id: z.string().min(1).max(256),
    user_id: z.string().min(1).max(256).optional(),
    email: z.email().max(320),
    email_verified: z.boolean(),
    name: z.string().max(512).optional(),
    role: z.string().max(64).optional(),
  })
  .passthrough()

export type DeploymentGrantClaims = z.infer<typeof DeploymentGrantClaimsSchema>

// OAuth token endpoint success payload (RFC 6749 §5.1). The access token is
// a Better Auth session token, but that is an implementation detail — the
// wire contract is a plain OAuth bearer response.
export const TokenExchangeSuccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().nonnegative(),
})

export type TokenExchangeSuccess = z.infer<typeof TokenExchangeSuccessSchema>

export type TokenExchangeErrorCode =
  | 'invalid_request'
  | 'unsupported_grant_type'
  | 'invalid_grant'
