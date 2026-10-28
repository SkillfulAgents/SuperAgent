import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { captureException } from '@shared/lib/error-reporting'
import { JWT_BEARER_GRANT_TYPE, type TokenExchangeErrorCode } from '@shared/lib/auth/token-exchange-schema'

// Bound the raw form body and the assertion itself; a legitimate grant is a
// small three-segment JWT.
const MAX_FORM_BODY_BYTES = 16 * 1024
const MAX_ASSERTION_LENGTH = 8 * 1024

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

function oauthError(
  c: Context,
  status: ContentfulStatusCode,
  error: TokenExchangeErrorCode | 'server_error',
  description?: string,
) {
  return c.json(
    { error, ...(description ? { error_description: description } : {}) },
    status,
    NO_STORE_HEADERS,
  )
}

// Reads a required single-valued form parameter; null means the request is
// malformed (missing or duplicated).
function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name)
  if (values.length !== 1) return null
  return values[0]
}

/**
 * RFC 7523 JWT bearer grant token endpoint (downstream Authorization Server).
 * POST /api/auth/token/exchange — accepts a platform-issued JWT authorization
 * grant and returns a deployment bearer access token backed by a Better Auth
 * session. Mounted before the Better Auth wildcard; the /api/auth/* rate
 * limiter applies.
 */
const tokenExchange = new Hono()

// Bound the request body by bytes before it is buffered. bodyLimit checks a
// declared Content-Length up front and, for chunked bodies with none, aborts
// mid-stream once the byte count is exceeded — so a body-less-Content-Length
// request can't force us to buffer unbounded input.
const limitBody = bodyLimit({
  maxSize: MAX_FORM_BODY_BYTES,
  onError: (c) => oauthError(c, 400, 'invalid_request'),
})

tokenExchange.post('/exchange', limitBody, async (c) => {
  const contentType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') {
    return oauthError(c, 400, 'invalid_request', 'content type must be application/x-www-form-urlencoded')
  }

  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return oauthError(c, 400, 'invalid_request')
  }

  const params = new URLSearchParams(rawBody)

  const grantType = singleParam(params, 'grant_type')
  if (!grantType) {
    return oauthError(c, 400, 'invalid_request', 'grant_type is required')
  }
  if (grantType !== JWT_BEARER_GRANT_TYPE) {
    return oauthError(c, 400, 'unsupported_grant_type')
  }

  const assertion = singleParam(params, 'assertion')
  if (!assertion) {
    return oauthError(c, 400, 'invalid_request', 'assertion is required exactly once')
  }
  if (assertion.length > MAX_ASSERTION_LENGTH) {
    return oauthError(c, 400, 'invalid_request', 'assertion is too large')
  }

  const { exchangeDeploymentGrant, TokenExchangeError } = await import('@shared/lib/auth/token-exchange')
  try {
    const result = await exchangeDeploymentGrant(assertion, {
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '',
    })
    return c.json(result, 200, NO_STORE_HEADERS)
  } catch (error) {
    if (error instanceof TokenExchangeError) {
      // Expected OAuth denials are normal control flow — never reported.
      // Internal failures masked as a denial are flagged by the service layer.
      return oauthError(c, 400, error.code)
    }
    // Genuinely unexpected failure. Report tags only — never the assertion,
    // resulting token, jti, or any identity claim.
    captureException(error, { tags: { component: 'token-exchange', operation: 'exchange' } })
    return oauthError(c, 500, 'server_error')
  }
})

export default tokenExchange
