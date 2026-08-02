/**
 * Integration tests for the mobile pairing endpoints, against a real Better
 * Auth instance and a real SQLite database in a temp data dir (mirrors
 * token-exchange.integration.test.ts).
 *
 * Proves the full contract: interactive-only minting, hashed single-use
 * pairing tokens, the atomic redeem, the fixed 90-day mobile session, the
 * renew/supersede flow, and per-user scoping of the devices list and revoke.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { Hono } from 'hono'

const DAY_MS = 24 * 60 * 60 * 1000

let tmpDir: string
// Deferred imports (must happen after env setup)
let dbModule: typeof import('@shared/lib/db')
let app: Hono

function wipeAuthTables(): void {
  for (const table of ['session', 'account', 'user', 'mobile_pairing_token', 'audit_log']) {
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

let userCounter = 0
/** Sign up a fresh user; returns their (password-method) bearer token + id. */
async function signUpUser(): Promise<{ token: string; userId: string; email: string }> {
  const { getAuth } = await import('@shared/lib/auth/index')
  userCounter += 1
  const email = `user${userCounter}-${crypto.randomUUID().slice(0, 8)}@example.com`
  const res = await getAuth().api.signUpEmail({
    body: { email, password: 'CorrectHorseBattery1!', name: `User ${userCounter}` },
  })
  if (!res.token || !res.user) throw new Error('signup did not return a session')
  return { token: res.token, userId: res.user.id, email }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function mintRequest(sessionToken?: string) {
  return app.request('/api/auth/mobile/pairing-token', {
    method: 'POST',
    headers: sessionToken ? bearer(sessionToken) : {},
  })
}

function redeemRequest(body: unknown, headers: Record<string, string> = {}) {
  return app.request('/api/auth/mobile/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function renewRequest(sessionToken: string, body: unknown = {}) {
  return app.request('/api/auth/mobile/renew', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(sessionToken) },
    body: JSON.stringify(body),
  })
}

/** Full mint → redeem round trip; returns the mobile session response. */
async function pairDevice(webToken: string, deviceName = 'Test Phone') {
  const mintRes = await mintRequest(webToken)
  expect(mintRes.status).toBe(200)
  const { token: pairingToken } = await mintRes.json()
  const redeemRes = await redeemRequest({ token: pairingToken, deviceName })
  expect(redeemRes.status).toBe(200)
  return redeemRes.json() as Promise<{
    token: string
    expiresAt: string
    user: { id: string; email: string; name: string }
  }>
}

function sessionRow(token: string) {
  return dbModule.sqlite
    .prepare(`SELECT id, user_id, expires_at, creation_method, device_name FROM session WHERE token = ?`)
    .get(token) as
    | { id: string; user_id: string; expires_at: number; creation_method: string; device_name: string | null }
    | undefined
}

beforeAll(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-pairing-')))
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  process.env.AUTH_MODE = 'true'
  process.env.BETTER_AUTH_SECRET = 'test-secret-0123456789abcdef0123456789abcdef'

  dbModule = await import('@shared/lib/db')

  const mobilePairingRoute = (await import('./mobile-pairing')).default
  const { Authenticated } = await import('../middleware/auth')
  app = new Hono()
  app.route('/api/auth/mobile', mobilePairingRoute)
  app.get('/api/protected', Authenticated(), (c) =>
    c.json({ userId: (c.get('user' as never) as { id: string }).id }),
  )
})

afterAll(() => {
  delete process.env.SUPERAGENT_DATA_DIR
  delete process.env.AUTH_MODE
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  wipeAuthTables()
  // Approval off so second/third signed-up users get working sessions.
  await writeAuthSettings({ requireAdminApproval: false })
})

describe('minting pairing tokens', () => {
  it('rejects an unauthenticated mint', async () => {
    const res = await mintRequest()
    expect(res.status).toBe(401)
  })

  it('mints for an interactive (password) session and stores only the hash', async () => {
    const { token: webToken, userId } = await signUpUser()
    const res = await mintRequest(webToken)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.token).toMatch(/^mp_[A-Za-z0-9_-]{40,}$/)
    expect(typeof body.deploymentUrl).toBe('string')
    expect(body.deploymentUrl).toMatch(/^https?:\/\//)
    const expiresIn = new Date(body.expiresAt).getTime() - Date.now()
    expect(expiresIn).toBeGreaterThan(4 * 60 * 1000)
    expect(expiresIn).toBeLessThanOrEqual(5 * 60 * 1000)

    // Plaintext never stored: exactly one row, holding the sha256 hex.
    const rows = dbModule.sqlite
      .prepare(`SELECT token_hash, user_id FROM mobile_pairing_token`)
      .all() as { token_hash: string; user_id: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(userId)
    expect(rows[0].token_hash).toBe(crypto.createHash('sha256').update(body.token).digest('hex'))
    expect(rows[0].token_hash).not.toBe(body.token)
  })

  it('refuses to mint from a mobile session', async () => {
    const { token: webToken } = await signUpUser()
    const mobile = await pairDevice(webToken)
    const res = await mintRequest(mobile.token)
    expect(res.status).toBe(403)
  })

  it('refuses to mint from a token-exchange session', async () => {
    const { userId } = await signUpUser()
    const { getAuth } = await import('@shared/lib/auth/index')
    const { withSessionAuditContext } = await import('@shared/lib/auth/session-audit')
    const ctx = await getAuth().$context
    const session = await withSessionAuditContext({ method: 'token-exchange' }, () =>
      ctx.internalAdapter.createSession(userId, false, {
        userAgent: 'token-exchange',
        ipAddress: '',
      }),
    )
    const res = await mintRequest(session!.token)
    expect(res.status).toBe(403)
  })

  it('caps outstanding tokens at 3 per user, dropping the oldest first', async () => {
    const { token: webToken, userId } = await signUpUser()
    const tokens: string[] = []
    for (let i = 0; i < 4; i++) {
      const res = await mintRequest(webToken)
      expect(res.status).toBe(200)
      tokens.push((await res.json()).token)
    }
    const count = dbModule.sqlite
      .prepare(`SELECT count(*) AS n FROM mobile_pairing_token WHERE user_id = ?`)
      .get(userId) as { n: number }
    expect(count.n).toBe(3)

    // The oldest was evicted; the newest still redeems.
    const oldest = await redeemRequest({ token: tokens[0] })
    expect(oldest.status).toBe(401)
    const newest = await redeemRequest({ token: tokens[3] })
    expect(newest.status).toBe(200)
  })
})

describe('redeeming', () => {
  it('redeems for a working 90-day mobile session', async () => {
    const { token: webToken, userId, email } = await signUpUser()
    const mintRes = await mintRequest(webToken)
    const { token: pairingToken } = await mintRes.json()

    const res = await redeemRequest(
      { token: pairingToken, deviceName: '  My iPhone  ', platform: 'ios' },
      { 'user-agent': 'GamutMobile/1.0' },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(typeof body.token).toBe('string')
    expect(body.user).toEqual({ id: userId, email, name: expect.any(String) })

    // Fixed ~90-day expiry.
    const lifetime = new Date(body.expiresAt).getTime() - Date.now()
    expect(lifetime).toBeGreaterThan(89 * DAY_MS)
    expect(lifetime).toBeLessThanOrEqual(90 * DAY_MS)

    // The bearer token authenticates through Authenticated().
    const protectedRes = await app.request('/api/protected', { headers: bearer(body.token) })
    expect(protectedRes.status).toBe(200)
    expect((await protectedRes.json()).userId).toBe(userId)

    // Session hygiene: method + trimmed device name persisted on the row.
    const row = sessionRow(body.token)
    expect(row?.creation_method).toBe('mobile')
    expect(row?.device_name).toBe('My iPhone')
  })

  it('caps the device name at 64 characters', async () => {
    const { token: webToken } = await signUpUser()
    const mobile = await pairDevice(webToken, 'x'.repeat(100))
    expect(sessionRow(mobile.token)?.device_name).toBe('x'.repeat(64))
  })

  it('rejects a double redeem with the same response as an unknown token', async () => {
    const { token: webToken } = await signUpUser()
    const mintRes = await mintRequest(webToken)
    const { token: pairingToken } = await mintRes.json()

    const first = await redeemRequest({ token: pairingToken })
    expect(first.status).toBe(200)

    const replay = await redeemRequest({ token: pairingToken })
    const unknown = await redeemRequest({ token: 'mp_never-existed' })
    expect(replay.status).toBe(401)
    expect(unknown.status).toBe(401)
    // Indistinguishable: same body for replayed and never-issued.
    expect(await replay.json()).toEqual(await unknown.json())
  })

  it('rejects an expired pairing token', async () => {
    const { token: webToken } = await signUpUser()
    const mintRes = await mintRequest(webToken)
    const { token: pairingToken } = await mintRes.json()
    dbModule.sqlite
      .prepare(`UPDATE mobile_pairing_token SET expires_at = ?`)
      .run(Date.now() - 1000)

    const res = await redeemRequest({ token: pairingToken })
    expect(res.status).toBe(401)
    // Consumed on the failed attempt: a later retry cannot succeed either.
    const retry = await redeemRequest({ token: pairingToken })
    expect(retry.status).toBe(401)
  })

  it('rejects a missing token with the same generic 401', async () => {
    const res = await redeemRequest({})
    expect(res.status).toBe(401)
  })

  it('refuses to mint a session for a banned user', async () => {
    const { token: webToken, userId } = await signUpUser()
    const mintRes = await mintRequest(webToken)
    const { token: pairingToken } = await mintRes.json()
    dbModule.sqlite.prepare(`UPDATE user SET banned = 1 WHERE id = ?`).run(userId)

    const res = await redeemRequest({ token: pairingToken })
    expect(res.status).toBe(401)
  })
})

describe('renewing', () => {
  it('rejects renew from a non-mobile (web) session', async () => {
    const { token: webToken } = await signUpUser()
    const res = await renewRequest(webToken)
    expect(res.status).toBe(403)
  })

  it('renews with supersede-grace: old session clamped to at most 7 days', async () => {
    const { token: webToken, userId } = await signUpUser()
    const mobile = await pairDevice(webToken)
    const oldRow = sessionRow(mobile.token)!

    const res = await renewRequest(mobile.token, {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe(userId)
    const lifetime = new Date(body.expiresAt).getTime() - Date.now()
    expect(lifetime).toBeGreaterThan(89 * DAY_MS)

    // New session is a distinct, working mobile session with the same label.
    const newRow = sessionRow(body.token)!
    expect(newRow.id).not.toBe(oldRow.id)
    expect(newRow.creation_method).toBe('mobile')
    expect(newRow.device_name).toBe('Test Phone')

    // Old session's expiry was clamped down into the grace window.
    const superseded = sessionRow(mobile.token)!
    expect(superseded.expires_at).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 5000)
    expect(superseded.expires_at).toBeLessThan(oldRow.expires_at)
    expect(superseded.expires_at).toBeGreaterThan(Date.now())
  })

  it('never extends an old session already inside the grace window', async () => {
    const { token: webToken } = await signUpUser()
    const mobile = await pairDevice(webToken)
    const soon = Date.now() + 1 * DAY_MS
    dbModule.sqlite
      .prepare(`UPDATE session SET expires_at = ? WHERE token = ?`)
      .run(soon, mobile.token)

    const res = await renewRequest(mobile.token, { purpose: 'renew' })
    expect(res.status).toBe(200)
    expect(sessionRow(mobile.token)!.expires_at).toBe(soon)
  })

  it('purpose=additional-device leaves the calling session untouched', async () => {
    const { token: webToken } = await signUpUser()
    const mobile = await pairDevice(webToken)
    const before = sessionRow(mobile.token)!

    const res = await renewRequest(mobile.token, {
      purpose: 'additional-device',
      deviceName: 'Second Phone',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(sessionRow(body.token)!.device_name).toBe('Second Phone')
    expect(sessionRow(mobile.token)!.expires_at).toBe(before.expires_at)
  })
})

describe('devices list and revoke', () => {
  it('lists only the caller-user’s mobile sessions, flagging the current one', async () => {
    const userA = await signUpUser()
    const userB = await signUpUser()
    const mobileA = await pairDevice(userA.token, 'A Phone')
    await pairDevice(userB.token, 'B Phone')

    // Via the web session: A sees exactly A's device, not current.
    const webView = await app.request('/api/auth/mobile/devices', { headers: bearer(userA.token) })
    expect(webView.status).toBe(200)
    const webBody = await webView.json()
    expect(webBody.devices).toHaveLength(1)
    expect(webBody.devices[0].deviceName).toBe('A Phone')
    expect(webBody.devices[0].isCurrent).toBe(false)
    expect(JSON.stringify(webBody)).not.toContain(mobileA.token)

    // Via the mobile session itself: isCurrent flips on.
    const mobileView = await app.request('/api/auth/mobile/devices', {
      headers: bearer(mobileA.token),
    })
    const mobileBody = await mobileView.json()
    expect(mobileBody.devices).toHaveLength(1)
    expect(mobileBody.devices[0].isCurrent).toBe(true)
  })

  it('requires authentication to list devices', async () => {
    const res = await app.request('/api/auth/mobile/devices')
    expect(res.status).toBe(401)
  })

  it('revokes an own mobile device: session dies, audit row written', async () => {
    const { token: webToken, userId } = await signUpUser()
    const mobile = await pairDevice(webToken)
    const mobileSessionId = sessionRow(mobile.token)!.id

    const res = await app.request(`/api/auth/mobile/devices/${mobileSessionId}`, {
      method: 'DELETE',
      headers: bearer(webToken),
    })
    expect(res.status).toBe(200)

    // The bearer token is dead with the row.
    expect(sessionRow(mobile.token)).toBeUndefined()
    const protectedRes = await app.request('/api/protected', { headers: bearer(mobile.token) })
    expect(protectedRes.status).toBe(401)

    const audit = dbModule.sqlite
      .prepare(`SELECT user_id, action FROM audit_log WHERE object = 'session' AND action = 'revoked' AND object_id = ?`)
      .get(mobileSessionId) as { user_id: string; action: string } | undefined
    expect(audit).toBeDefined()
    expect(audit!.user_id).toBe(userId)
  })

  it('404s when revoking another user’s device', async () => {
    const userA = await signUpUser()
    const userB = await signUpUser()
    const mobileB = await pairDevice(userB.token)
    const idB = sessionRow(mobileB.token)!.id

    const res = await app.request(`/api/auth/mobile/devices/${idB}`, {
      method: 'DELETE',
      headers: bearer(userA.token),
    })
    expect(res.status).toBe(404)
    // B's session is untouched.
    expect(sessionRow(mobileB.token)).toBeDefined()
  })

  it('404s when revoking an own non-mobile session', async () => {
    const { token: webToken } = await signUpUser()
    const webSessionId = sessionRow(webToken)!.id

    const res = await app.request(`/api/auth/mobile/devices/${webSessionId}`, {
      method: 'DELETE',
      headers: bearer(webToken),
    })
    expect(res.status).toBe(404)
    expect(sessionRow(webToken)).toBeDefined()
  })
})
