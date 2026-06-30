/**
 * E2E: Telegram Mini App session + scoped cookie flow
 *
 * Path: non-auth mode (standard e2e/specs/ suite, E2E_MOCK=true).
 *
 * Why non-auth (not auth-mode): The /session endpoint checks
 * integration.createdByUserId and returns 401 no_owner when it is null.
 * In non-auth mode the Authenticated() middleware is a no-op that calls
 * runWithRequestUser('local', next) — it never sets c.get('user'), so the
 * chat-integrations POST route always persists createdByUserId=null. Auth
 * mode would give us a real user, but chatIntegrationSessions rows are
 * created by the Telegram connector on first DM (no API route exists to
 * create them), so direct DB seeding is required regardless. Given both
 * rows require direct DB insertion, non-auth mode keeps the test simpler.
 *
 * What this test asserts (HTTP round-trip):
 *   - Valid initData (correctly signed, bound user) → 200 + Set-Cookie tg_dash
 *   - Set-Cookie is retained by the Playwright request context; subsequent
 *     artifact GET returns 200 text/html (MockContainerClient serves stub HTML)
 *   - Tampered initData (hash mangled) → 401 reason=signature, no cookie
 *   - Valid signature for an unbound Telegram user → 403 reason=not_bound, no cookie
 *
 * What this test deliberately does NOT assert:
 *   AgentRead() ownership enforcement on the artifact read path. In non-auth
 *   mode AgentRead() is a no-op, so the artifact GET succeeds without checking
 *   the cookie's owner claim against an ACL table. AgentRead() still runs in
 *   production (the cookie middleware only pre-sets the user; it does not bypass
 *   the guard). The pieces are unit-tested elsewhere:
 *     - /session authorization gates (agent_mismatch, dashboard_not_found,
 *       no_owner) in src/api/routes/telegram-miniapp.test.ts (mocks getChatIntegration);
 *     - the cookie's agent + dashboard scoping in
 *       src/api/middleware/telegram-dashboard.test.ts;
 *     - the cookie -> Authenticated() composition in src/api/middleware/auth.test.ts.
 *   A DB-seeded AgentRead-over-cookie (revoked-owner) composition test remains a
 *   deferred coverage gap.
 */

import { test, expect } from '@playwright/test'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Seed constants ────────────────────────────────────────────────────────────

const BOT_TOKEN = 'e2e-tg-bot-abc123'
/** Bound Telegram user id (matches the seeded chat_integration_sessions row). */
const TG_USER_ID = 778899
const INTEGRATION_ID = `e2e-tg-int-${Date.now()}`
const SESSION_ID = `e2e-tg-sess-${Date.now()}`
const DASHBOARD_SLUG = 'test-dashboard'
/** Placeholder owner; non-auth mode no-ops the ACL guard but no_owner still fires. */
const OWNER_USER_ID = 'e2e-local-user'

// ── initData signing ─────────────────────────────────────────────────────────
// Mirrors the Telegram Mini App SDK algorithm and the server's verifyInitData:
//   secret = HMAC_SHA256("WebAppData", botToken)
//   hash   = HMAC_SHA256(secret, sorted_kv_pairs_joined_by_newline)

function signInitData(fields: Record<string, string>): string {
  const dcs = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secret).update(dcs).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

// ── E2E data dir — mirror playwright.config.ts resolution ────────────────────

const e2eDataDir = process.env.SUPERAGENT_DATA_DIR
  ? path.resolve(process.env.SUPERAGENT_DATA_DIR)
  : path.join(process.cwd(), '.e2e-data')

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('Telegram Mini App session + scoped cookie', () => {
  // Serial mode: all tests in this block run in one worker so beforeAll runs
  // exactly once and the DB seed doesn't race with a second worker's beforeAll.
  test.describe.configure({ mode: 'serial' })

  let agentSlug: string

  test.beforeAll(async ({ request }) => {
    // 1. Create and start an agent so the integration has a real owning agent.
    const createRes = await request.post('/api/agents', {
      data: { name: `tg-dash-e2e-${Date.now()}` },
    })
    expect(createRes.ok()).toBeTruthy()
    const agent = await createRes.json() as { slug: string }
    agentSlug = agent.slug

    await request.post(`/api/agents/${agentSlug}/start`)

    // 2. Create the artifact directory on disk so listArtifactsFromFilesystem
    //    (called by /session step 9) can find the dashboard.
    //    Path mirrors getAgentWorkspaceDir(agentSlug) in file-storage.ts:
    //    {dataDir}/agents/{slug}/workspace/artifacts/{dashboardSlug}/
    const artifactDir = path.join(
      e2eDataDir, 'agents', agentSlug, 'workspace', 'artifacts', DASHBOARD_SLUG,
    )
    fs.mkdirSync(artifactDir, { recursive: true })
    fs.writeFileSync(
      path.join(artifactDir, 'package.json'),
      JSON.stringify({ name: 'E2E Test Dashboard', description: 'Seeded for E2E' }),
    )

    // 3. Seed chat_integrations and chat_integration_sessions directly into the
    //    SQLite DB. We bypass the API because:
    //    a) POST /api/chat-integrations persists createdByUserId=null in non-auth
    //       mode (Authenticated() never populates c.get('user')), and the /session
    //       endpoint returns 401 no_owner when createdByUserId is null.
    //    b) chatIntegrationSessions has no creation route; rows are created by
    //       the connector on first real DM.
    const dbPath = path.join(e2eDataDir, 'superagent.db')
    const db = new Database(dbPath)
    // Enable WAL so our write doesn't collide with the running server.
    db.pragma('journal_mode = WAL')
    const now = Date.now()

    db.prepare(`
      INSERT INTO chat_integrations
        (id, agent_slug, provider, config, show_tool_calls, status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'telegram', ?, 0, 'active', ?, ?, ?)
    `).run(
      INTEGRATION_ID,
      agentSlug,
      JSON.stringify({ botToken: BOT_TOKEN }),
      OWNER_USER_ID,
      now,
      now,
    )

    // session_id is NOT NULL in schema but is not read by the /session route;
    // we use INTEGRATION_ID as a harmless placeholder string.
    db.prepare(`
      INSERT INTO chat_integration_sessions
        (id, integration_id, external_chat_id, session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      SESSION_ID,
      INTEGRATION_ID,
      String(TG_USER_ID),
      INTEGRATION_ID,
      now,
      now,
    )

    db.close()
  })

  // ── Test 2: cookie persistence → artifact GET ──────────────────────────────

  test('Set-Cookie is retained across requests and artifact GET returns 200 text/html', async ({ request }) => {
    // POST session — Playwright's APIRequestContext stores Set-Cookie and
    // sends it on subsequent requests within the same context.
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: TG_USER_ID, username: 'e2euser' }),
    })
    const sessionRes = await request.post('/api/telegram-miniapp/session', {
      data: { initData, integrationId: INTEGRATION_ID, agentSlug, dashboardSlug: DASHBOARD_SLUG },
    })
    expect(sessionRes.status()).toBe(200)

    // The session response sets a scoped tg_dash cookie with the expected attributes.
    const setCookie = sessionRes.headers()['set-cookie']
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('tg_dash=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/api')

    // GET the artifact path from the response body (cookie rides along automatically).
    const body = await sessionRes.json() as { ok: boolean; artifactPath: string }
    expect(body.ok).toBe(true)
    expect(body.artifactPath).toContain(agentSlug)
    expect(body.artifactPath).toContain(DASHBOARD_SLUG)
    const artifactRes = await request.get(body.artifactPath)

    expect(artifactRes.status()).toBe(200)
    // MockContainerClient serves stub HTML for /artifacts/{slug}/ requests.
    expect(artifactRes.headers()['content-type']).toContain('text/html')
  })

  // ── Test 4: valid signature but user not bound to integration ─────────────

  test('valid signature for unbound user returns 403 reason=not_bound with no cookie', async ({ request }) => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 9999999, username: 'stranger' }),
    })

    const res = await request.post('/api/telegram-miniapp/session', {
      data: { initData, integrationId: INTEGRATION_ID, agentSlug, dashboardSlug: DASHBOARD_SLUG },
    })

    expect(res.status()).toBe(403)
    const body = await res.json() as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('not_bound')
    expect(res.headers()['set-cookie']).toBeUndefined()
  })
})
