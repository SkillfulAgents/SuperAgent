/**
 * A stand-in for the platform half of the stack, so the app suite can run in CI.
 *
 * The three-node stack needs local Supabase, a wrangler worker and a platform
 * checkout — none of which CI has. But only two of the platform's jobs matter to
 * the app: telling the desktop which deployment belongs to the org, and minting
 * the short-lived grant it exchanges there. Both are small, and the second is
 * only small *because* the deployment verifies a real RS256 signature against a
 * published JWKS — so this stub holds a real keypair rather than pretending.
 *
 * What it deliberately does NOT stand in for is the deployment. That stays a
 * real auth-mode build of this app, because the checks are about what the
 * renderer does against a real API, and a canned `/api/agents` would turn the
 * interesting assertions into assertions about the stub.
 *
 * The trade is explicit: this proves the *app's* behaviour, not the platform
 * contract. Wire schemas, the org-runtime-token rejection, the real SSRF policy
 * and the undici form-POST handling stay with the live suites, which run against
 * the real thing. If the platform changes its shape, this stub will happily keep
 * agreeing with a version that no longer exists — so it is a regression net, not
 * a contract test.
 */

import { createServer } from 'node:http'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const DEPLOYMENT_ASSERTION_TYP = 'deployment-assertion+jwt'
const GRANT_LIFETIME_SEC = 300

/** A 3-segment token whose payload carries `orgId` — all `decodeOrgIdFromToken` reads. */
function fakePlatformToken(orgId) {
  const segment = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'none' })}.${segment({ orgId })}.signature`
}

/**
 * Start the stub. Returns the base URL to use as BOTH the platform proxy and the
 * auth issuer — the desktop reads them from separate env vars, but nothing
 * requires them to be different hosts, and one server is one less thing to wait
 * for in CI.
 */
export async function startStubPlatform({
  deploymentUrl,
  orgId,
  email,
  platformToken,
  port = 0,
} = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'stub-platform-key', alg: 'RS256', use: 'sig' }

  let issuer = ''
  let minted = 0

  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json') => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(payload)
    }

    const url = new URL(req.url, `http://127.0.0.1`)

    if (req.method === 'GET' && url.pathname === '/jwks') {
      send(200, { keys: [jwk] })
      return
    }

    // Discovery. Presented with the raw member-bound key, exactly as the real
    // endpoint requires — a mismatch here is the same 401 the platform gives.
    if (req.method === 'GET' && url.pathname === '/v1/me/deployments') {
      if (req.headers.authorization !== `Bearer ${platformToken}`) {
        send(401, { error: 'unauthorized' })
        return
      }
      send(200, [
        {
          org_id: orgId,
          deployment_url: deploymentUrl,
          authorization_server: deploymentUrl,
          status: 'deployed',
        },
      ])
      return
    }

    if (req.method === 'POST' && url.pathname === '/token/deployment-assertion') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('subject_token') !== platformToken) {
          send(400, { error: 'invalid_grant' })
          return
        }
        const resource = form.get('resource')
        if (!resource) {
          send(400, { error: 'invalid_request' })
          return
        }
        const now = Math.floor(Date.now() / 1000)
        new SignJWT({
          org_id: orgId,
          email,
          email_verified: true,
          name: 'E2E Owner',
          role: 'owner',
        })
          .setProtectedHeader({ alg: 'RS256', typ: DEPLOYMENT_ASSERTION_TYP, kid: jwk.kid })
          .setIssuer(issuer)
          .setSubject(`stub-user|${email}`)
          // The deployment pins its own base URL as the sole audience, and
          // strips a trailing slash before comparing — so mint it the same way.
          .setAudience(resource.replace(/\/+$/, ''))
          .setIssuedAt(now)
          .setExpirationTime(now + GRANT_LIFETIME_SEC)
          // Single-use on the deployment side, so it must differ every time.
          .setJti(`stub-grant-${++minted}-${now}`)
          .sign(privateKey)
          .then((assertion) => {
            send(200, {
              access_token: assertion,
              issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
              token_type: 'Bearer',
              expires_in: GRANT_LIFETIME_SEC,
            })
          })
          .catch(() => send(500, { error: 'server_error' }))
      })
      return
    }

    send(404, { error: 'not_found' })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${server.address().port}`

  return {
    url: issuer,
    get grantsMinted() {
      return minted
    },
    /** `PLATFORM_TOKEN` for the deployment: its org pin must match the grant's. */
    deploymentPlatformToken: fakePlatformToken(orgId),
    /** `AUTH_PROVIDERS_JSON` for the deployment: enables platform login, points at this issuer. */
    deploymentAuthProviders: JSON.stringify([
      {
        id: 'platform',
        type: 'oidc',
        enabled: true,
        displayName: 'Stub Platform',
        issuer,
        clientId: 'stub-client',
        clientSecret: 'stub-secret',
      },
    ]),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
