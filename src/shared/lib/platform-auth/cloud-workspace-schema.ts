import { z } from 'zod'

// Zod schemas + protocol constants for the cloud-workspace discovery + grant
// exchange chain. Validated at every network boundary (per the repo's
// parse-at-the-boundary rule) before a value is trusted.

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** RFC 8693 token-exchange grant type (platform `/token/deployment-assertion`). */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
/** Subject token type for the exchange: the caller's platform access token. */
export const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
/** Requested token type: a signed JWT deployment grant. */
export const REQUESTED_TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt'
/** RFC 7523 JWT bearer grant type (the deployment's own `/token/exchange`). */
export const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/** Path on the platform auth issuer that mints the deployment grant. */
export const DEPLOYMENT_ASSERTION_PATH = '/token/deployment-assertion'
/** Discovery path on the platform proxy. */
export const ME_DEPLOYMENTS_PATH = '/v1/me/deployments'
/** Path on the target deployment that exchanges the grant for a session token. */
export const DEPLOYMENT_TOKEN_EXCHANGE_PATH = '/api/auth/token/exchange'

/** The only deployment status we act on — others aren't grantable. */
export const DEPLOYED_STATUS = 'deployed'

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * One entry from `GET /v1/me/deployments`. `authorization_server` is the
 * deployment's own auth server (currently equal to `deployment_url`) and is the
 * value passed as the RFC 8693 `resource` param. `status` is left as a free
 * string so a new platform enum value doesn't fail the parse — we filter to
 * {@link DEPLOYED_STATUS} in code.
 */
export const DeploymentDiscoveryEntrySchema = z.object({
  org_id: z.string(),
  deployment_url: z.string(),
  authorization_server: z.string(),
  status: z.string(),
})
export type DeploymentDiscoveryEntry = z.infer<typeof DeploymentDiscoveryEntrySchema>

/** The discovery endpoint returns a bare JSON array. */
export const DeploymentDiscoveryResponseSchema = z.array(DeploymentDiscoveryEntrySchema)

/** Success body of the platform `/token/deployment-assertion` exchange. */
export const DeploymentGrantResponseSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
})

/**
 * Success body of the target deployment's RFC 7523 `/api/auth/token/exchange`.
 * This is the durable credential we persist ("deployment token").
 */
export const DeploymentTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
})
