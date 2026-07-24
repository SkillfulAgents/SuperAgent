/**
 * Integration tests for the RFC 7523 token endpoint + bearer plugin, against
 * a real Better Auth instance and a real SQLite database in a temp data dir.
 *
 * Proves the full contract: form parsing, grant verification (signature,
 * issuer, audience, typ, lifetime, org gate, email_verified), atomic jti
 * replay, provisioning through Better Auth (first-user bootstrap, pending
 * approval, banned users, account linking, stable subject mapping), and that
 * the issued access token authenticates through Authenticated() via the
 * bearer plugin.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { Hono } from 'hono'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTPayload } from 'jose'

// Spy on Sentry reporting while keeping every other export real.
const captureExceptionMock = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/error-reporting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/error-reporting')>()),
  captureException: captureExceptionMock,
}))

const TEST_ISSUER = 'https://auth.test.example'
const TEST_ORG = 'org_test_123'
const SIGNING_KID = 'platform-oidc-main'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

let tmpDir: string
let privateKey: CryptoKey
let audience: string
// Deferred imports (must happen after env setup)
let dbModule: typeof import('@shared/lib/db')
let app: Hono

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

interface GrantOptions {
  payload?: Partial<JWTPayload> & Record<string, unknown>
  typ?: string
  issuer?: string
  audience?: string | string[]
  iat?: number
  exp?: number
}

async function signGrant(options: GrantOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'sub_member_1',
    org_id: TEST_ORG,
    user_id: 'platform-user-uuid-1',
    email: 'member@example.com',
    email_verified: true,
    name: 'Member One',
    role: 'member',
    jti: crypto.randomUUID(),
    ...options.payload,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', typ: options.typ ?? 'deployment-assertion+jwt', kid: SIGNING_KID })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? audience)
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 120)
    .sign(privateKey)
}

function exchangeRequest(assertion: string, overrides: {
  grantType?: string
  contentType?: string
  rawBody?: string
  headers?: Record<string, string>
} = {}) {
  const body =
    overrides.rawBody ??
    new URLSearchParams({
      grant_type: overrides.grantType ?? GRANT_TYPE,
      assertion,
    }).toString()
  return app.request('/api/auth/token/exchange', {
    method: 'POST',
    headers: {
      'content-type': overrides.contentType ?? 'application/x-www-form-urlencoded',
      ...overrides.headers,
    },
    body,
  })
}

function countRows(table: string): number {
  const row = dbModule.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

function wipeAuthTables(): void {
  for (const table of ['session', 'account', 'user', 'token_exchange_jti']) {
    dbModule.sqlite.prepare(`DELETE FROM ${table}`).run()
  }
}

async function writeAuthSettings(auth: Record<string, unknown>): Promise<void> {
  const settingsPath = path.join(tmpDir, 'settings.json')
  const current = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    : {}
  fs.writeFileSync(settingsPath, JSON.stringify({ ...current, auth }))
  const { clearSettingsCache } = await import('@shared/lib/config/settings')
  clearSettingsCache()
}

beforeAll(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'token-exchange-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  process.env.AUTH_MODE = 'true'
  process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
  // Org-pinned deployment: unverified decode of the orgId claim is all the
  // org gate needs, so an unsigned JWT-shaped token is fine here.
  process.env.PLATFORM_TOKEN = `${b64url({ alg: 'RS256' })}.${b64url({ orgId: TEST_ORG })}.sig`
  process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
    { id: 'platform', type: 'oidc', issuer: TEST_ISSUER, clientId: 'superagent-org-test' },
  ])

  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  const jwk = await exportJWK(pair.publicKey)
  jwk.kid = SIGNING_KID
  jwk.alg = 'RS256'
  const { _setOidcJwksResolverForTest } = await import('./oidc-jwt')
  _setOidcJwksResolverForTest(createLocalJWKSet({ keys: [jwk] }) as never)

  const { getAppBaseUrl } = await import('./config')
  audience = getAppBaseUrl()

  dbModule = await import('@shared/lib/db')

  const tokenExchangeRoute = (await import('../../../api/routes/token-exchange')).default
  const { Authenticated } = await import('../../../api/middleware/auth')
  app = new Hono()
  app.route('/api/auth/token', tokenExchangeRoute)
  app.get('/api/protected', Authenticated(), (c) =>
    c.json({ userId: (c.get('user' as never) as { id: string }).id }),
  )
})

afterAll(async () => {
  const { _setOidcJwksResolverForTest } = await import('./oidc-jwt')
  _setOidcJwksResolverForTest(null)
  delete process.env.SUPERAGENT_DATA_DIR
  delete process.env.AUTH_MODE
  delete process.env.PLATFORM_TOKEN
  delete process.env.AUTH_PROVIDERS_JSON
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  wipeAuthTables()
  await writeAuthSettings({})
})

describe('request validation', () => {
  it('rejects a non-form content type', async () => {
    const res = await exchangeRequest('x', { contentType: 'application/json' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  it('rejects a missing grant_type', async () => {
    const res = await exchangeRequest('x', { rawBody: `assertion=x` })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
  })

  it('rejects a wrong grant_type with unsupported_grant_type', async () => {
    const res = await exchangeRequest('x', { grantType: 'authorization_code' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unsupported_grant_type')
  })

  it('rejects a missing assertion', async () => {
    const res = await exchangeRequest('', {
      rawBody: `grant_type=${encodeURIComponent(GRANT_TYPE)}`,
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
  })

  it('rejects a duplicated assertion parameter', async () => {
    const grant = await signGrant()
    const res = await exchangeRequest('', {
      rawBody: `grant_type=${encodeURIComponent(GRANT_TYPE)}&assertion=${grant}&assertion=${grant}`,
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
  })

  it('rejects an oversized assertion', async () => {
    const res = await exchangeRequest('a'.repeat(9000))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
  })
})

describe('grant verification', () => {
  it('exchanges a valid grant for a working bearer token', async () => {
    const res = await exchangeRequest(await signGrant(), {
      headers: { 'user-agent': 'SuperagentDesktop/1.0' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBeGreaterThan(0)
    expect(typeof body.access_token).toBe('string')

    // The token authenticates through Authenticated() via the bearer plugin.
    const protectedRes = await app.request('/api/protected', {
      headers: { authorization: `Bearer ${body.access_token}` },
    })
    expect(protectedRes.status).toBe(200)
    const who = await protectedRes.json()
    expect(typeof who.userId).toBe('string')

    // Session hygiene: userAgent recorded for the sessions list.
    const session = dbModule.sqlite
      .prepare(`SELECT user_agent FROM session WHERE token = ?`)
      .get(body.access_token) as { user_agent: string }
    expect(session.user_agent).toBe('SuperagentDesktop/1.0')
  })

  it('rejects a garbage bearer token on protected routes', async () => {
    const res = await app.request('/api/protected', {
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a grant with the wrong audience', async () => {
    const res = await exchangeRequest(await signGrant({ audience: 'https://other.example' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant with the wrong issuer', async () => {
    const res = await exchangeRequest(await signGrant({ issuer: 'https://evil.example' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant without the deployment-assertion typ (org JWT confusion)', async () => {
    const res = await exchangeRequest(await signGrant({ typ: 'JWT' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects an expired grant', async () => {
    const now = Math.floor(Date.now() / 1000)
    const res = await exchangeRequest(await signGrant({ iat: now - 300, exp: now - 60 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant living longer than five minutes', async () => {
    const now = Math.floor(Date.now() / 1000)
    const res = await exchangeRequest(await signGrant({ exp: now + 3600 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant for another organization', async () => {
    const res = await exchangeRequest(await signGrant({ payload: { org_id: 'org_other' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant with an unverified email', async () => {
    const res = await exchangeRequest(await signGrant({ payload: { email_verified: false } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant missing required claims', async () => {
    const res = await exchangeRequest(await signGrant({ payload: { jti: undefined } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a multi-valued audience even when it contains this deployment', async () => {
    const res = await exchangeRequest(
      await signGrant({ audience: [audience, 'https://other.example'] }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant issued in the future', async () => {
    const now = Math.floor(Date.now() / 1000)
    const res = await exchangeRequest(await signGrant({ iat: now + 120, exp: now + 240 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('rejects a grant whose email is not an email address', async () => {
    const res = await exchangeRequest(
      await signGrant({ payload: { email: 'not-an-email' } }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('refuses to exchange when the platform provider is disabled', async () => {
    const enabled = process.env.AUTH_PROVIDERS_JSON
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      { id: 'platform', type: 'oidc', issuer: TEST_ISSUER, clientId: 'superagent-org-test', enabled: false },
    ])
    try {
      const res = await exchangeRequest(await signGrant())
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')
    } finally {
      process.env.AUTH_PROVIDERS_JSON = enabled
    }
  })

  it('rejects an oversized declared content-length up front', async () => {
    const res = await app.request('/api/auth/token/exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(64 * 1024),
      },
      body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion: 'x' }).toString(),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request')
  })
})

describe('replay prevention', () => {
  it('rejects a replayed jti', async () => {
    const grant = await signGrant()
    const first = await exchangeRequest(grant)
    expect(first.status).toBe(200)
    const second = await exchangeRequest(grant)
    expect(second.status).toBe(400)
    expect((await second.json()).error).toBe('invalid_grant')
  })

  it('lets exactly one of two concurrent redemptions win', async () => {
    const grant = await signGrant()
    const [a, b] = await Promise.all([exchangeRequest(grant), exchangeRequest(grant)])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 400])
    expect(countRows('session')).toBe(1)
  })
})

describe('provisioning and identity mapping', () => {
  it('promotes the first exchanged user to admin', async () => {
    const res = await exchangeRequest(await signGrant())
    expect(res.status).toBe(200)
    const user = dbModule.sqlite
      .prepare(`SELECT role, email, email_verified FROM user`)
      .get() as { role: string; email: string; email_verified: number }
    expect(user.role).toBe('admin')
    expect(user.email).toBe('member@example.com')
    expect(user.email_verified).toBe(1)
  })

  it('keeps the (providerId, sub) mapping stable across email changes', async () => {
    const first = await exchangeRequest(await signGrant())
    expect(first.status).toBe(200)
    const originalUserId = (dbModule.sqlite.prepare(`SELECT id FROM user`).get() as { id: string }).id

    const second = await exchangeRequest(
      await signGrant({ payload: { email: 'renamed@example.com' } }),
    )
    expect(second.status).toBe(200)
    expect(countRows('user')).toBe(1)
    const sessions = dbModule.sqlite
      .prepare(`SELECT DISTINCT user_id FROM session`)
      .all() as { user_id: string }[]
    expect(sessions).toEqual([{ user_id: originalUserId }])
  })

  it('links the platform identity to an existing user with the same email', async () => {
    const { getAuth } = await import('./index')
    await getAuth().api.signUpEmail({
      body: {
        email: 'member@example.com',
        password: 'CorrectHorseBattery1!',
        name: 'Local Member',
      },
    })
    expect(countRows('user')).toBe(1)

    const res = await exchangeRequest(await signGrant())
    expect(res.status).toBe(200)
    expect(countRows('user')).toBe(1)
    const accounts = dbModule.sqlite
      .prepare(`SELECT provider_id FROM account ORDER BY provider_id`)
      .all() as { provider_id: string }[]
    expect(accounts.map((a) => a.provider_id)).toEqual(['credential', 'platform'])
  })

  it('creates one user and one mapping for concurrent first exchanges', async () => {
    const [a, b] = await Promise.all([
      exchangeRequest(await signGrant()),
      exchangeRequest(await signGrant()),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(countRows('user')).toBe(1)
    const mappings = dbModule.sqlite
      .prepare(`SELECT count(*) AS n FROM account WHERE provider_id = 'platform'`)
      .get() as { n: number }
    expect(mappings.n).toBe(1)
    expect(countRows('session')).toBe(2)
  })
})

describe('approval and ban enforcement', () => {
  it('refuses a session for a user pending admin approval', async () => {
    // Seed a first user so the exchanged user is not the bootstrap admin.
    const first = await exchangeRequest(await signGrant())
    expect(first.status).toBe(200)

    await writeAuthSettings({ requireAdminApproval: true })
    const res = await exchangeRequest(
      await signGrant({ payload: { sub: 'sub_member_2', email: 'second@example.com' } }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')

    // User row exists (pending), but no session was minted for it.
    const pending = dbModule.sqlite
      .prepare(`SELECT id, banned, ban_reason FROM user WHERE email = 'second@example.com'`)
      .get() as { id: string; banned: number; ban_reason: string }
    expect(pending.banned).toBe(1)
    expect(pending.ban_reason).toBe('Pending admin approval')
    const sessions = dbModule.sqlite
      .prepare(`SELECT count(*) AS n FROM session WHERE user_id = ?`)
      .get(pending.id) as { n: number }
    expect(sessions.n).toBe(0)
  })

  it('refuses a session for a banned user', async () => {
    const first = await exchangeRequest(await signGrant())
    expect(first.status).toBe(200)
    dbModule.sqlite.prepare(`UPDATE user SET banned = 1, ban_reason = 'nope'`).run()

    const res = await exchangeRequest(await signGrant())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('auto-unbans when the ban has expired', async () => {
    const first = await exchangeRequest(await signGrant())
    expect(first.status).toBe(200)
    dbModule.sqlite
      .prepare(`UPDATE user SET banned = 1, ban_expires = ?`)
      .run(Date.now() - 60_000)

    const res = await exchangeRequest(await signGrant())
    expect(res.status).toBe(200)
    const user = dbModule.sqlite.prepare(`SELECT banned FROM user`).get() as { banned: number }
    expect(user.banned).toBe(0)
  })
})

describe('observability', () => {
  beforeEach(() => captureExceptionMock.mockClear())

  it('does not report expected OAuth denials to Sentry', async () => {
    const res = await exchangeRequest(await signGrant({ audience: 'https://other.example' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('reports an unexpected replay-table failure while still denying the client', async () => {
    // Drop the replay table so jti consumption hits a real DB error (not a
    // normal replay conflict). The client still sees a generic denial.
    dbModule.sqlite.prepare(`DROP TABLE token_exchange_jti`).run()
    try {
      const res = await exchangeRequest(await signGrant())
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({ component: 'token-exchange', operation: 'jti-consume' }),
        }),
      )
    } finally {
      dbModule.sqlite
        .prepare('CREATE TABLE `token_exchange_jti` (`jti` text PRIMARY KEY NOT NULL, `expires_at` integer NOT NULL)')
        .run()
      dbModule.sqlite
        .prepare('CREATE INDEX `token_exchange_jti_expires_at_idx` ON `token_exchange_jti` (`expires_at`)')
        .run()
    }
  })
})
