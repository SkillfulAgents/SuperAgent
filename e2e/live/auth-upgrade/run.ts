/** Real auth-mode app processes sharing one persistent 1.6-created database. */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { betterSqlite3 } from '../../../src/shared/lib/db/drivers/better-sqlite3'
import { authAccount, mobileDevice } from '../../../src/shared/lib/db/schema'
import { MobileSessionResponseSchema } from '../../../src/shared/lib/auth/mobile-pairing-schema'
import { persistedSettingsSchema } from '../../../src/shared/lib/config/settings-schema'
import { createOidcTestServer, responseCookies } from '../../../src/shared/lib/auth/testing/oidc-server'
import {
  authorizeSchema, credentialSchema, devicesSchema, packageSchema, pairingSchema,
  privateSnapshotSchema, proofSchema, sessionSchema, sqliteSchemaSchema, tableInfoSchema,
} from './schema'

const baselineDir = process.env.AUTH_UPGRADE_BASELINE_DIR
const upgradedDir = process.env.AUTH_UPGRADE_CURRENT_DIR ?? process.cwd()
const outputDir = process.env.AUTH_UPGRADE_OUTPUT_DIR ?? '/tmp/ba17-validation/auth-upgrade'
const port = Number(process.env.AUTH_UPGRADE_PORT ?? '33175')
const base = `http://127.0.0.1:${port}`
const email = 'ada@example.com'
const password = `Upgrade-${randomBytes(24).toString('base64url')}!1aA`
const secret = randomBytes(48).toString('base64url')
const secrets = new Set([password, secret])
const checks: Array<{ phase: string; name: string }> = []
let phase = 'prepare'
let child: ChildProcess | undefined
let childLog = ''
let childLogName = ''
let scratch = ''
let baselineVersion = 'unknown'
let upgradedVersion = 'unknown'
const started = Date.now()

function remember<T extends string>(value: T): T {
  if (value) secrets.add(value)
  return value
}
function sanitize(value: string): string {
  let result = value
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) result = result.replaceAll(value, '[redacted]')
  return result.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
}
function check(name: string, condition: unknown): asserts condition {
  assert.ok(condition, name)
  checks.push({ phase, name })
  console.log(`PASS [${phase}] ${name}`)
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name)
  checks.push({ phase, name })
  console.log(`PASS [${phase}] ${name}`)
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function request(endpoint: string, options: {
  body?: Record<string, unknown>; cookie?: string; token?: string; method?: string; origin?: boolean
} = {}) {
  return fetch(`${base}${endpoint}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'), redirect: 'manual',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.origin ? { origin: base } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      'user-agent': 'Gamut-iOS-AuthUpgrade-Validation/1.0',
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
}

async function session(options: { cookie?: string; token?: string }) {
  const response = await request('/api/auth/get-session', options)
  assert.equal(response.status, 200, 'Session lookup status')
  const result = sessionSchema.parse(await response.json())
  if (result) remember(result.session.token)
  return result
}

async function sessionIs(name: string, credentials: { cookie?: string; token?: string }, userId: string) {
  const result = await session(credentials)
  equal(name, result?.user.id, userId)
  return result!
}

async function passwordLogin(signUp = false) {
  const response = await request(`/api/auth/${signUp ? 'sign-up' : 'sign-in'}/email`, {
    body: { email, password, ...(signUp ? { name: 'Upgrade Validation' } : {}) }, origin: true,
  })
  assert.equal(response.status, 200, 'Password login status')
  const credentials = credentialSchema.parse(await response.json())
  remember(credentials.token)
  const cookie = remember(responseCookies(response))
  check('password response has an HttpOnly session cookie', response.headers.getSetCookie().some(value => /session_token=.*HttpOnly/i.test(value)))
  equal('bearer echo header is stripped by the real API middleware', response.headers.get('set-auth-token'), null)
  return { ...credentials, cookie }
}

async function beginOAuth(version: '1.6' | '1.7') {
  const response = await request(`/api/auth/sign-in/${version === '1.6' ? 'oauth2' : 'social'}`, {
    body: {
      ...(version === '1.6' ? { providerId: 'platform' } : { provider: 'platform' }),
      callbackURL: `${base}/`, errorCallbackURL: `${base}/login-error`,
    }, origin: true,
  })
  assert.equal(response.status, 200, 'OAuth initiation status')
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- Zod validates this URL; malformed fixture responses must fail the run.
  const authorizationUrl = new URL(authorizeSchema.parse(await response.json()).url)
  remember(authorizationUrl.searchParams.get('state') ?? '')
  remember(authorizationUrl.searchParams.get('nonce') ?? '')
  equal('OAuth uses the already registered legacy callback', authorizationUrl.searchParams.get('redirect_uri'), `${base}/api/auth/oauth2/callback/platform`)
  equal('OAuth requests S256 PKCE', authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  if (version === '1.7') check('new OAuth flow includes ID-token nonce', authorizationUrl.searchParams.get('nonce'))
  const authorized = await fetch(authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert.equal(authorized.status, 302, 'Authority must accept the code request')
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- A malformed authority redirect must fail the run.
  const callback = new URL(authorized.headers.get('location')!)
  remember(callback.searchParams.get('code') ?? '')
  return { callback, cookie: remember(responseCookies(response)) }
}

async function oauthLogin(version: '1.6' | '1.7') {
  const flow = await beginOAuth(version)
  const response = await fetch(flow.callback, { headers: { cookie: flow.cookie }, redirect: 'manual' })
  equal('OAuth callback completes successfully', response.headers.get('location'), `${base}/`)
  const cookie = remember(responseCookies(response))
  const result = await session({ cookie })
  check('OAuth issued an authenticated session', result)
  equal('OAuth session retains interactive creation method', result.session.creationMethod, 'oidc')
  return { cookie, token: result.session.token, userId: result.user.id }
}

async function pair(cookie: string) {
  const minted = await request('/api/auth/mobile/pairing-token', { method: 'POST', cookie, origin: true })
  assert.equal(minted.status, 200, 'Pairing token creation status')
  const pairing = pairingSchema.parse(await minted.json())
  remember(pairing.token)
  equal('pairing payload uses the canonical deployment URL', pairing.deploymentUrl, base)
  const redeem = await request('/api/auth/mobile/redeem', {
    body: { token: pairing.token, deviceName: 'Upgrade iPhone', platform: 'ios' },
  })
  assert.equal(redeem.status, 200, 'Native cookie-free pairing redemption status')
  equal('pairing credentials are uncacheable', redeem.headers.get('cache-control'), 'no-store')
  const mobile = MobileSessionResponseSchema.parse(await redeem.json())
  remember(mobile.token)
  remember(mobile.refreshToken)
  const replay = await request('/api/auth/mobile/redeem', { body: { token: pairing.token, platform: 'ios' } })
  equal('pairing token is single use', replay.status, 401)
  return mobile
}

async function renew(refreshToken: string) {
  const response = await request('/api/auth/mobile/renew', { body: { refreshToken, deviceName: 'Upgrade iPhone' } })
  assert.equal(response.status, 200, 'Native cookie-free refresh status')
  equal('refresh credentials are uncacheable', response.headers.get('cache-control'), 'no-store')
  const mobile = MobileSessionResponseSchema.parse(await response.json())
  remember(mobile.token)
  remember(mobile.refreshToken)
  check('refresh secret rotates', mobile.refreshToken !== refreshToken)
  return mobile
}

async function deviceIs(token: string, deviceId: string) {
  const response = await request('/api/auth/mobile/devices', { token })
  assert.equal(response.status, 200, 'Device list status')
  const payload = devicesSchema.parse(await response.json())
  equal('native device identity is stable and current', payload.devices, [{
    id: deviceId, deviceName: 'Upgrade iPhone', platform: 'ios', isCurrent: true,
  }])
}

async function snapshot(label: string) {
  // Open only after the baseline app has created the database. The driver
  // performs no migrations, so the observation cannot upgrade the schema.
  const handle = await betterSqlite3(path.join(scratch, 'superagent.db')).open()
  try {
    const structure = sqliteSchemaSchema.parse(await handle.db.all(sql`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`))
    const columns = tableInfoSchema.parse(await handle.db.all(sql`PRAGMA table_info('account')`))
    const accounts = await handle.db.select().from(authAccount).all()
    const devices = await handle.db.select().from(mobileDevice).all()
    const passwordHash = accounts.find(account => account.providerId === 'credential')?.password
    assert.ok(passwordHash, 'Baseline password hash must exist')
    const result = privateSnapshotSchema.parse({
      label, schemaFingerprint: digest(JSON.stringify(structure)), accountColumns: columns.map(column => column.name),
      accounts: accounts.map(({ id, providerId, accountId, userId }) => ({ id, providerId, accountId, userId })),
      passwordDigest: digest(passwordHash), mobileRefreshDigest: devices[0]?.refreshTokenHash ?? null,
    })
    await writeFile(path.join(outputDir, `${label}-private-snapshot.json`), JSON.stringify(result, null, 2), { mode: 0o600 })
    return result
  } finally {
    await handle.close()
  }
}

async function stop() {
  if (!child) return
  const current = child
  if (current.exitCode === null && current.signalCode === null) {
    const exited = once(current, 'exit')
    current.kill('SIGTERM')
    const done = await Promise.race([exited.then(() => true), delay(12_000, false, { ref: false })])
    if (!done) {
      current.kill('SIGKILL')
      await exited
    }
  }
  await writeFile(path.join(outputDir, childLogName), sanitize(childLog), { mode: 0o600 })
  child = undefined
  childLog = ''
}

async function start(appDir: string, name: string, issuer: string) {
  await stop()
  phase = name
  // Refuse an occupied port instead of attaching to a developer's app. The
  // production binder otherwise retries with the next port.
  const probe = createServer()
  probe.listen(port, '127.0.0.1')
  await once(probe, 'listening')
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  childLogName = `${name}-server.log`
  child = spawn(process.execPath, ['dist/web/server.mjs'], {
    cwd: appDir,
    env: {
      ...process.env,
      NODE_ENV: 'test', AUTH_MODE: 'true', E2E_MOCK: 'true',
      PORT: String(port), TRUSTED_ORIGINS: base, HOST: '127.0.0.1',
      SUPERAGENT_DATA_DIR: scratch, BETTER_AUTH_SECRET: secret,
      PLATFORM_TOKEN: '', ANTHROPIC_API_KEY: 'sk-ant-e2e-mock',
      AUTH_PROVIDERS_JSON: JSON.stringify([{
        id: 'platform', type: 'oidc', issuer, discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        clientId: 'test-client', scopes: ['openid', 'profile', 'email'],
      }]),
    }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => { childLog += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { childLog += chunk.toString() })
  let spawnError: Error | undefined
  child.on('error', error => { spawnError = error })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`App exited before readiness (${child.exitCode}); see ${childLogName}`)
    try {
      const ready = await request('/api/auth-config')
      if (ready.status === 200) {
        check('production API process is ready in auth mode', true)
        return
      }
    } catch { /* Startup has not bound its listener yet. */ }
    await delay(150)
  }
  throw new Error(`App readiness timed out; see ${childLogName}`)
}

async function main() {
  assert.ok(baselineDir, 'Set AUTH_UPGRADE_BASELINE_DIR to a built Better Auth 1.6 checkout')
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, 'Valid isolated port required')
  await mkdir(outputDir, { recursive: true })
  await chmod(outputDir, 0o700)
  scratch = await mkdtemp(path.join(tmpdir(), 'gamut-auth-upgrade-'))
  const oidc = await createOidcTestServer()
  oidc.state.acceptedRedirectUri = `${base}/api/auth/oauth2/callback/platform`
  let error: string | undefined
  try {
    baselineVersion = packageSchema.parse(JSON.parse(await readFile(path.join(baselineDir, 'node_modules/better-auth/package.json'), 'utf8'))).version
    upgradedVersion = packageSchema.parse(JSON.parse(await readFile(path.join(upgradedDir, 'node_modules/better-auth/package.json'), 'utf8'))).version
    check('baseline runtime uses Better Auth 1.6', baselineVersion.startsWith('1.6.'))
    check('upgraded runtime uses Better Auth 1.7', upgradedVersion.startsWith('1.7.'))
    const settings = persistedSettingsSchema.parse({
      auth: { signupMode: 'open', requireAdminApproval: false, maxConcurrentSessions: 50, allowLocalAuth: true },
      container: { containerRunner: 'docker' }, app: { hasCompletedOnboarding: true },
    })
    await writeFile(path.join(scratch, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })

    await start(baselineDir, 'baseline-1.6', oidc.state.issuer)
    equal('protected API rejects an unauthenticated caller', (await request('/api/agents')).status, 401)
    const signup = await passwordLogin(true)
    const browser = await passwordLogin()
    equal('password sign-in returns the original user', browser.user.id, signup.user.id)
    const oldOAuth = await oauthLogin('1.6')
    equal('OIDC links the existing password identity', oldOAuth.userId, signup.user.id)
    const oldMobile = await pair(browser.cookie)
    equal('paired iOS account matches the browser', oldMobile.user.id, signup.user.id)
    await sessionIs('iOS access works without cookies or Origin', { token: oldMobile.token }, signup.user.id)
    await deviceIs(oldMobile.token, oldMobile.deviceId)
    const pending = await beginOAuth('1.6')
    const before = await snapshot('before-upgrade')
    check('1.6 account schema has no issuer column', !before.accountColumns.includes('issuer'))
    equal('refresh is persisted only as a digest', before.mobileRefreshDigest, digest(oldMobile.refreshToken))
    equal('password and provider identities are both persisted', before.accounts.map(account => account.providerId).sort(), ['credential', 'platform'])

    await start(upgradedDir, 'upgraded-1.7', oidc.state.issuer)
    await sessionIs('1.6 signup cookie survives upgrade', { cookie: signup.cookie }, signup.user.id)
    await sessionIs('1.6 browser cookie survives upgrade', { cookie: browser.cookie }, signup.user.id)
    await sessionIs('1.6 password bearer survives upgrade', { token: browser.token }, signup.user.id)
    await sessionIs('1.6 OIDC cookie survives upgrade', { cookie: oldOAuth.cookie }, signup.user.id)
    await sessionIs('1.6 OIDC bearer survives upgrade', { token: oldOAuth.token }, signup.user.id)
    await sessionIs('1.6 mobile access survives upgrade', { token: oldMobile.token }, signup.user.id)
    equal('old iOS bearer reaches the protected app API', (await request('/api/agents', { token: oldMobile.token })).status, 200)
    const renewed = await renew(oldMobile.refreshToken)
    equal('1.6 refresh keeps the same device family on 1.7', renewed.deviceId, oldMobile.deviceId)
    equal('rotation revokes the 1.6 mobile access immediately', await session({ token: oldMobile.token }), null)
    equal('rotated 1.6 refresh cannot be replayed', (await request('/api/auth/mobile/renew', { body: { refreshToken: oldMobile.refreshToken } })).status, 401)
    await sessionIs('rotated access is accepted by 1.7', { token: renewed.token }, signup.user.id)
    await deviceIs(renewed.token, oldMobile.deviceId)
    const newBrowser = await passwordLogin()
    equal('1.7 verifies the unchanged 1.6 password hash', newBrowser.user.id, signup.user.id)
    const pendingResult = await fetch(pending.callback, { headers: { cookie: pending.cookie }, redirect: 'manual' })
    const pendingRedirect = new URL(pendingResult.headers.get('location')!, base)
    // 1.7 prefixes database state keys with auth-state:; 1.6 stored the bare
    // state. Even migrating that key would leave the old flow without the
    // required ID-token nonce, so the safe transition is a fresh login.
    equal('in-flight 1.6 OAuth requires a fresh state and nonce-bound login', pendingRedirect.searchParams.get('error'), 'state_mismatch')
    check('rejected in-flight login does not mint a session cookie', !responseCookies(pendingResult).includes('session_token='))
    const newOAuth = await oauthLogin('1.7')
    equal('fresh 1.7 OAuth retains the 1.6 user identity', newOAuth.userId, signup.user.id)
    const after = await snapshot('after-upgrade')
    equal('upgrade requires no schema migration', after.schemaFingerprint, before.schemaFingerprint)
    equal('upgrade keeps account row ids and provider subjects', after.accounts, before.accounts)
    equal('upgrade does not rewrite the password hash', after.passwordDigest, before.passwordDigest)
    check('1.7 account schema still has no issuer column', !after.accountColumns.includes('issuer'))

    await start(baselineDir, 'rollback-1.6', oidc.state.issuer)
    await sessionIs('rollback accepts the 1.7 password cookie', { cookie: newBrowser.cookie }, signup.user.id)
    await sessionIs('rollback accepts the 1.7 OIDC cookie', { cookie: newOAuth.cookie }, signup.user.id)
    await sessionIs('rollback accepts the 1.7 mobile access', { token: renewed.token }, signup.user.id)
    const rolledMobile = await renew(renewed.refreshToken)
    equal('rollback rotates the 1.7 refresh without changing device identity', rolledMobile.deviceId, oldMobile.deviceId)
    equal('rollback rotation invalidates previous access', await session({ token: renewed.token }), null)
    await sessionIs('rollback replacement access authenticates', { token: rolledMobile.token }, signup.user.id)
    await deviceIs(rolledMobile.token, oldMobile.deviceId)
    const rolledOAuth = await oauthLogin('1.6')
    equal('rollback OAuth reuses the original provider identity', rolledOAuth.userId, signup.user.id)
    const rolledSnapshot = await snapshot('after-rollback')
    equal('rollback leaves schema unchanged', rolledSnapshot.schemaFingerprint, before.schemaFingerprint)
    equal('rollback leaves account identities unchanged', rolledSnapshot.accounts, before.accounts)
    equal('rollback leaves password hash unchanged', rolledSnapshot.passwordDigest, before.passwordDigest)

    await start(upgradedDir, 'upgraded-again-1.7', oidc.state.issuer)
    await sessionIs('second upgrade accepts rollback-issued mobile access', { token: rolledMobile.token }, signup.user.id)
    await sessionIs('second upgrade accepts rollback-issued OIDC cookie', { cookie: rolledOAuth.cookie }, signup.user.id)
    const finalMobile = await renew(rolledMobile.refreshToken)
    equal('second upgrade retains device family across another refresh', finalMobile.deviceId, oldMobile.deviceId)
    const logout = await request('/api/auth/sign-out', { body: {}, cookie: newBrowser.cookie, origin: true })
    equal('sign-out succeeds after upgrade and rollback', logout.status, 200)
    equal('sign-out keeps the platform login local', logout.headers.get('location'), null)
    equal('sign-out revokes its browser cookie', await session({ cookie: newBrowser.cookie }), null)
    equal('sign-out revokes its bearer token', await session({ token: newBrowser.token }), null)
    await sessionIs('sign-out preserves another valid browser session', { cookie: browser.cookie }, signup.user.id)
    const revoked = await request(`/api/auth/mobile/devices/${oldMobile.deviceId}`, { method: 'DELETE', cookie: browser.cookie })
    equal('device revocation works after both transitions', revoked.status, 200)
    equal('device revocation invalidates the final mobile access', await session({ token: finalMobile.token }), null)
    equal('device revocation invalidates the final refresh credential', (await request('/api/auth/mobile/renew', { body: { refreshToken: finalMobile.refreshToken } })).status, 401)
    const devices = devicesSchema.parse(await (await request('/api/auth/mobile/devices', { cookie: browser.cookie })).json())
    equal('revoked device disappears from browser device list', devices.devices, [])
    await sessionIs('device revocation preserves browser authentication', { cookie: browser.cookie }, signup.user.id)
    const finalSnapshot = await snapshot('final')
    equal('entire sequence leaves schema unchanged', finalSnapshot.schemaFingerprint, before.schemaFingerprint)
    equal('entire sequence keeps one stable provider identity', finalSnapshot.accounts, before.accounts)
    equal('authority accepted every registered redirect and PKCE verifier', oidc.state.failures, [])
    equal('only completed OAuth logins exchanged an authorization code', oidc.state.tokenExchanges.length, 3)
  } catch (caught) {
    error = sanitize(caught instanceof Error ? caught.message : String(caught))
  } finally {
    await stop()
    await oidc.close()
    const proof = proofSchema.parse({
      passed: !error, baselineVersion, upgradedVersion, checks, elapsedMs: Date.now() - started,
      ...(error ? { error } : {}),
      coverage: [
        'Real auth-mode production API processes and SQLite migrations',
        'Real local OIDC authority, RS256/JWKS, PKCE and nonce verification',
        'Persistent 1.6 password/OIDC sessions through 1.7 upgrade and 1.6 rollback',
        'iOS cookie-free pairing, bearer auth, refresh rotation and device revocation',
        'No platform production service, real user credentials, or native iOS UI involved',
      ],
    })
    await writeFile(path.join(outputDir, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 })
    if (process.env.AUTH_UPGRADE_KEEP_DATA !== 'true') await rm(scratch, { recursive: true, force: true })
  }
  if (error) throw new Error(error)
  console.log(`Auth upgrade validation passed: ${checks.length} checks (${baselineVersion} -> ${upgradedVersion} -> ${baselineVersion} -> ${upgradedVersion}).`)
  console.log(`Sanitized proof: ${path.join(outputDir, 'proof.json')}`)
}

main().catch(error => {
  console.error(sanitize(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
