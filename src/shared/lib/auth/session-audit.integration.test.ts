/**
 * Integration coverage for the deployment-side session audit trail, against a
 * real Better Auth instance and a real SQLite database in a temp data dir.
 *
 * The point of these tests is symmetry: a browser password login and a headless
 * RFC 7523 token exchange must each leave exactly one `session:created` row,
 * distinguishable by `method`, with nothing sensitive in `details`. Unit tests
 * can prove the mapping, but only a real dispatch proves the endpoint paths the
 * mapping is keyed on are the ones Better Auth actually reports.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { Hono } from 'hono'
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose'

const TEST_ISSUER = 'https://auth.test.example'
const TEST_ORG = 'org_audit_123'
const SIGNING_KID = 'platform-oidc-main'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const PASSWORD = 'correct-horse-battery-staple'

let tmpDir: string
let privateKey: CryptoKey
let audience: string
let dbModule: typeof import('@shared/lib/db')
let authModule: typeof import('./index')
let app: Hono

interface AuditRow {
  object: string
  action: string
  object_id: string
  user_id: string | null
  details: string | null
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function auditRows(object?: string): AuditRow[] {
  const sql = object
    ? `SELECT object, action, object_id, user_id, details FROM audit_log WHERE object = ? ORDER BY rowid`
    : `SELECT object, action, object_id, user_id, details FROM audit_log ORDER BY rowid`
  const stmt = dbModule.sqlite.prepare(sql)
  return (object ? stmt.all(object) : stmt.all()) as AuditRow[]
}

function detailsOf(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.details ?? '{}')
}

async function signGrant(payload: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'sub_member_1',
    org_id: TEST_ORG,
    user_id: 'platform-user-uuid-1',
    email: 'member@example.com',
    email_verified: true,
    name: 'Member One',
    role: 'member',
    jti: crypto.randomUUID(),
    ...payload,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'deployment-assertion+jwt', kid: SIGNING_KID })
    .setIssuer(TEST_ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .sign(privateKey)
}

function exchange(assertion: string) {
  return app.request('/api/auth/token/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
  })
}

beforeAll(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-audit-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  process.env.AUTH_MODE = 'true'
  process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
  process.env.PLATFORM_TOKEN = `${b64url({ alg: 'RS256' })}.${b64url({ orgId: TEST_ORG })}.sig`
  process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
    { id: 'platform', type: 'oidc', issuer: TEST_ISSUER, clientId: 'superagent-org-audit' },
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
  authModule = await import('./index')

  const tokenExchangeRoute = (await import('../../../api/routes/token-exchange')).default
  app = new Hono()
  app.route('/api/auth/token', tokenExchangeRoute)
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
  for (const table of ['session', 'account', 'user', 'token_exchange_jti', 'audit_log']) {
    dbModule.sqlite.prepare(`DELETE FROM ${table}`).run()
  }
  // Approval defaults to on, which bans every user after the first and would
  // make "two users, two methods" fail for a reason that has nothing to do
  // with auditing.
  fs.writeFileSync(
    path.join(tmpDir, 'settings.json'),
    JSON.stringify({ auth: { requireAdminApproval: false } }),
  )
  const { clearSettingsCache } = await import('@shared/lib/config/settings')
  clearSettingsCache()
})

describe('browser password login', () => {
  it('writes one session:created row per sign-up and sign-in', async () => {
    const auth = authModule.getAuth()
    const email = 'browser-user@example.com'

    // Registration auto-signs-in, so this is itself a session-creation path.
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Browser User' } })
    expect(auditRows('session')).toHaveLength(1)

    await auth.api.signInEmail({ body: { email, password: PASSWORD } })

    const rows = auditRows('session')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.action).toBe('created')
      expect(detailsOf(row)).toEqual({ method: 'password' })
    }
  })

  it('attributes the row to the signed-in user and the session it created', async () => {
    const auth = authModule.getAuth()
    const email = 'attributed@example.com'
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Attributed' } })

    const [row] = auditRows('session')
    const session = dbModule.sqlite
      .prepare(`SELECT id, user_id FROM session WHERE id = ?`)
      .get(row.object_id) as { id: string; user_id: string } | undefined

    expect(session).toBeDefined()
    expect(row.user_id).toBe(session!.user_id)
  })

  it('writes no session row for a failed password attempt', async () => {
    const auth = authModule.getAuth()
    const email = 'wrong-password@example.com'
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: 'Wrong Password' } })

    await expect(
      auth.api.signInEmail({ body: { email, password: 'not-the-password-at-all' } }),
    ).rejects.toThrow()

    // Only the sign-up's session — the rejected attempt minted nothing.
    expect(auditRows('session')).toHaveLength(1)
  })
})

describe('admin impersonation', () => {
  /** Sign a user in and return a bearer usable as that user's credentials. */
  async function signInAs(email: string): Promise<string> {
    const res = await authModule.getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    })
    const token = res.headers.get('set-auth-token')
    expect(token).toBeTruthy()
    return token!
  }

  async function seedAdminAndTarget(): Promise<{ adminId: string; targetId: string }> {
    const auth = authModule.getAuth()
    // First user is promoted to admin by the user.create.after hook.
    await auth.api.signUpEmail({
      body: { email: 'admin@example.com', password: PASSWORD, name: 'Admin' },
    })
    await auth.api.signUpEmail({
      body: { email: 'target@example.com', password: PASSWORD, name: 'Target' },
    })
    const row = (email: string) =>
      (dbModule.sqlite.prepare(`SELECT id FROM user WHERE email = ?`).get(email) as { id: string })
        .id
    return { adminId: row('admin@example.com'), targetId: row('target@example.com') }
  }

  it('credits the impersonating admin as the actor and keeps the target in details', async () => {
    const { adminId, targetId } = await seedAdminAndTarget()
    const adminToken = await signInAs('admin@example.com')
    dbModule.sqlite.prepare(`DELETE FROM audit_log`).run()

    await authModule.getAuth().api.impersonateUser({
      body: { userId: targetId },
      headers: new Headers({ authorization: `Bearer ${adminToken}` }),
    })

    const rows = auditRows('session')
    expect(rows).toHaveLength(1)
    // Better Auth puts the target on session.userId and the admin on
    // session.impersonatedBy; the audit row must invert that, or the UI blames
    // the victim for the admin's action.
    expect(rows[0].user_id).toBe(adminId)
    expect(detailsOf(rows[0])).toEqual({ method: 'impersonation', targetUserId: targetId })
  })

  it('survives revocation of the impersonation session', async () => {
    const { adminId, targetId } = await seedAdminAndTarget()
    const adminToken = await signInAs('admin@example.com')
    dbModule.sqlite.prepare(`DELETE FROM audit_log`).run()

    await authModule.getAuth().api.impersonateUser({
      body: { userId: targetId },
      headers: new Headers({ authorization: `Bearer ${adminToken}` }),
    })

    const [row] = auditRows('session')
    dbModule.sqlite.prepare(`DELETE FROM session WHERE id = ?`).run(row.object_id)

    // The whole point of the trail: with the session gone, who did it and to
    // whom is still on record.
    const [after] = auditRows('session')
    expect(after.user_id).toBe(adminId)
    expect(detailsOf(after).targetUserId).toBe(targetId)
  })

  it('does not confuse an ordinary login by the same admin with impersonation', async () => {
    const { adminId } = await seedAdminAndTarget()
    dbModule.sqlite.prepare(`DELETE FROM audit_log`).run()

    await signInAs('admin@example.com')

    const [row] = auditRows('session')
    expect(row.user_id).toBe(adminId)
    expect(detailsOf(row)).toEqual({ method: 'password' })
  })
})

describe('token exchange', () => {
  it('writes one session:created row tagged token-exchange with the grant org', async () => {
    const res = await exchange(await signGrant())
    expect(res.status).toBe(200)

    const rows = auditRows('session')
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('created')
    expect(detailsOf(rows[0])).toEqual({ method: 'token-exchange', orgId: TEST_ORG })
  })

  it('attributes the row to the provisioned user and the minted session', async () => {
    const res = await exchange(await signGrant())
    const body = await res.json()

    const [row] = auditRows('session')
    const session = dbModule.sqlite
      .prepare(`SELECT id, user_id FROM session WHERE token = ?`)
      .get(body.access_token) as { id: string; user_id: string }

    expect(row.object_id).toBe(session.id)
    expect(row.user_id).toBe(session.user_id)
  })

  it('leaks no assertion, token, jti, email, or name into details', async () => {
    const jti = crypto.randomUUID()
    const assertion = await signGrant({ jti })
    const res = await exchange(assertion)
    const body = await res.json()

    const [row] = auditRows('session')
    const serialized = row.details ?? ''
    for (const secret of [assertion, body.access_token, jti, 'member@example.com', 'Member One']) {
      expect(serialized).not.toContain(secret)
    }
    expect(Object.keys(detailsOf(row)).sort()).toEqual(['method', 'orgId'])
  })

  it('writes no session row for a rejected grant', async () => {
    const res = await exchange(await signGrant({ org_id: 'org_someone_else' }))
    expect(res.status).toBe(400)
    expect(auditRows('session')).toHaveLength(0)
  })

  it('records one row per exchange, not one per replay attempt', async () => {
    const assertion = await signGrant()
    expect((await exchange(assertion)).status).toBe(200)
    expect((await exchange(assertion)).status).toBe(400)

    expect(auditRows('session')).toHaveLength(1)
  })
})

describe('symmetry', () => {
  it('makes both credential sources visible in one filterable object', async () => {
    const auth = authModule.getAuth()
    await auth.api.signUpEmail({
      body: { email: 'both@example.com', password: PASSWORD, name: 'Both' },
    })
    expect((await exchange(await signGrant())).status).toBe(200)

    const methods = auditRows('session').map((row) => detailsOf(row).method)
    expect(methods.sort()).toEqual(['password', 'token-exchange'])
  })
})
