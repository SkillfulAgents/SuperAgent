import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// LIVE end-to-end for the SUP-362 cloud-workspace chain. Hard-gated on
// LIVE_E2E=1 so it never runs in CI. Drives the REAL client + service +
// settings persistence against a running local platform (auth 3002 + proxy
// 8787) and a running SUP-361 "cloud deployment" (8899), with NO mocks.
//
// Harness exports:
//   LIVE_PLATFORM_TOKEN     — a member-bound plat_sa_ access key
//   LIVE_PROXY_URL          — e.g. http://127.0.0.1:8787
//   LIVE_AUTH_ISSUER_URL    — e.g. http://127.0.0.1:3002
//   LIVE_DEPLOYMENT_URL     — the seeded org_deployment.deployment_url (node 3)
//   LIVE_ORG_ID             — the seeded org id
//   LIVE_EMAIL              — the seeded member's email
//   LIVE_ORG_RUNTIME_TOKEN  — (optional) an org-runtime JWT, for the reject test
// ---------------------------------------------------------------------------

const RUN = process.env.LIVE_E2E === '1'
const d = RUN ? describe : describe.skip

const TOKEN = process.env.LIVE_PLATFORM_TOKEN ?? ''
const PROXY = process.env.LIVE_PROXY_URL ?? 'http://127.0.0.1:8787'
const ISSUER = process.env.LIVE_AUTH_ISSUER_URL ?? 'http://127.0.0.1:3002'
const DEPLOYMENT_URL = process.env.LIVE_DEPLOYMENT_URL ?? 'http://127.0.0.1:8899'
const ORG_ID = process.env.LIVE_ORG_ID ?? ''
const EMAIL = process.env.LIVE_EMAIL ?? ''

type Record_ = {
  deploymentUrl: string
  orgId: string
  token: string
  tokenPreview: string
  expiresAt: string
  updatedAt: string
  userId: string | null
  memberId: string | null
  tokenFingerprint: string | null
}

// The live stack is loopback, so the service's shipped-build loopback refusal
// has to be opted out of the same way a local dev run does.
const LOCAL_POLICY = { allowLocalhost: true }

async function readRecord(): Promise<Record_ | null> {
  const { readCloudWorkspaceRecord } = await import('@shared/lib/platform-auth/cloud-workspace-record')
  return readCloudWorkspaceRecord() as Record_ | null
}
async function tamperRecord(patch: Partial<Record_>): Promise<void> {
  const { mutateSettings } = await import('@shared/lib/config/settings')
  mutateSettings((s) => {
    s.cloudWorkspace = { ...(s.cloudWorkspace as Record_), ...patch }
  })
}

d('SUP-362 live cloud-workspace chain', () => {
  beforeAll(async () => {
    // Point env at the live stack; take the desktop path (settings token, no
    // env PLATFORM_TOKEN / AUTH_MODE) and pass the Electron gate.
    process.env.PLATFORM_PROXY_URL = PROXY
    process.env.PLATFORM_AUTH_ISSUER_URL = ISSUER
    delete process.env.PLATFORM_TOKEN
    delete process.env.AUTH_MODE
    ;(process as { type?: string }).type = 'browser'
    // Unpackaged (dev) Electron — the only mode that may trust a loopback
    // deployment target. Mirrors what `electron-vite dev` publishes.
    process.env.SUPERAGENT_IS_PACKAGED = '0'

    const dataDir = mkdtempSync(join(tmpdir(), 'sup362-live-'))
    mkdirSync(dataDir, { recursive: true })
    process.env.SUPERAGENT_DATA_DIR = dataDir

    // Seed the connected platform account through the cache-consistent path.
    const { mutateSettings } = await import('@shared/lib/config/settings')
    const now = new Date().toISOString()
    mutateSettings((s) => {
      s.platformAuth = {
        token: TOKEN,
        tokenPreview: `${TOKEN.slice(0, 6)}...${TOKEN.slice(-4)}`,
        email: EMAIL,
        label: 'live-e2e',
        orgId: ORG_ID,
        orgName: 'Live E2E Org',
        role: 'owner',
        userId: null,
        memberId: null,
        createdAt: now,
        updatedAt: now,
      }
    })
  })

  afterAll(() => {
    ;(process as { type?: string }).type = undefined
  })

  it('has the required harness env', () => {
    expect(TOKEN, 'LIVE_PLATFORM_TOKEN').not.toBe('')
    expect(ORG_ID, 'LIVE_ORG_ID').not.toBe('')
    expect(EMAIL, 'LIVE_EMAIL').not.toBe('')
  })

  it('① discovery returns the seeded deployed workspace', async () => {
    const { fetchDeployments } = await import('@shared/lib/platform-auth/cloud-workspace-client')
    const list = await fetchDeployments(TOKEN)
    expect(Array.isArray(list)).toBe(true)
    const match = list.find((e) => e.deployment_url === DEPLOYMENT_URL)
    expect(match, `deployment ${DEPLOYMENT_URL} in ${JSON.stringify(list)}`).toBeTruthy()
    expect(match!.status).toBe('deployed')
    expect(match!.org_id).toBe(ORG_ID)
    expect(match!.authorization_server).toBe(DEPLOYMENT_URL)
  })

  it('② grant mint returns a well-formed, correctly-scoped assertion', async () => {
    const { requestDeploymentGrant } = await import('@shared/lib/platform-auth/cloud-workspace-client')
    const grant = await requestDeploymentGrant(TOKEN, DEPLOYMENT_URL)
    expect(grant.split('.')).toHaveLength(3)
    const header = decodeProtectedHeader(grant)
    expect(header.alg).toBe('RS256')
    expect(header.typ).toBe('deployment-assertion+jwt')
    expect(header.kid).toBe('platform-oidc-main')
    const claims = decodeJwt(grant)
    expect(claims.aud).toBe(DEPLOYMENT_URL)
    expect(claims.iss).toBe(ISSUER)
    expect(claims.org_id).toBe(ORG_ID)
    expect(claims.email).toBe(EMAIL)
    expect(claims.email_verified).toBe(true)
    expect(typeof claims.jti).toBe('string')
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(300)
    expect(claims.exp! - claims.iat!).toBeGreaterThan(0)
  })

  it('③ the grant exchanges at the deployment for a session token (and is single-use)', async () => {
    const { requestDeploymentGrant, exchangeGrantAtDeployment } = await import(
      '@shared/lib/platform-auth/cloud-workspace-client'
    )
    const grant = await requestDeploymentGrant(TOKEN, DEPLOYMENT_URL)
    const { token, expiresInSec } = await exchangeGrantAtDeployment(DEPLOYMENT_URL, grant, LOCAL_POLICY)
    expect(token.length).toBeGreaterThan(0)
    expect(expiresInSec).toBeGreaterThan(0)
    // Replaying the same single-use grant must fail (jti burned).
    await expect(exchangeGrantAtDeployment(DEPLOYMENT_URL, grant, LOCAL_POLICY)).rejects.toMatchObject({
      name: 'CloudWorkspaceError',
    })
  })

  it('④ getCloudWorkspace finds the workspace and persists a valid deployment token', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    const status = await getCloudWorkspace()
    expect(status).toMatchObject({
      available: true,
      found: true,
      deploymentUrl: DEPLOYMENT_URL,
      orgId: ORG_ID,
      hasValidToken: true,
    })
    const record = await readRecord()
    expect(record).toBeTruthy()
    expect(record!.deploymentUrl).toBe(DEPLOYMENT_URL)
    expect(record!.orgId).toBe(ORG_ID)
    expect(record!.token.length).toBeGreaterThan(0)
    expect(new Date(record!.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('⑤ a valid stored token is reused (not re-minted) on the next call', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    const before = await readRecord()
    await getCloudWorkspace()
    const after = await readRecord()
    expect(after!.token).toBe(before!.token)
    expect(after!.updatedAt).toBe(before!.updatedAt) // no write ⇒ no re-mint
  })

  it('⑥ a token within the 1h refresh buffer is re-minted', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    const before = await readRecord()
    await tamperRecord({ expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() })
    await getCloudWorkspace()
    const after = await readRecord()
    expect(after!.token).not.toBe(before!.token) // fresh mint
    expect(new Date(after!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000)
  })

  it('⑦ a token bound to a different deployment URL is discarded and re-minted', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    const before = await readRecord()
    await tamperRecord({ deploymentUrl: 'https://stale.example.com' })
    await getCloudWorkspace()
    const after = await readRecord()
    expect(after!.deploymentUrl).toBe(DEPLOYMENT_URL)
    expect(after!.token).not.toBe(before!.token)
  })

  it('⑨ the persisted record is bound to the acting account (fingerprint round-trips)', async () => {
    const record = await readRecord()
    // Written, Zod-validated, and read back through real settings.json.
    expect(record!.tokenFingerprint).toMatch(/^[0-9a-f]{32}$/)
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(TOKEN).digest('hex').slice(0, 32)
    expect(record!.tokenFingerprint).toBe(expected)
  })

  it('⑩ a record fingerprinted to another credential is discarded and re-minted', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    const before = await readRecord()
    await tamperRecord({ tokenFingerprint: 'ffffffffffffffffffffffffffffffff' })
    await getCloudWorkspace()
    const after = await readRecord()
    expect(after!.token).not.toBe(before!.token)
    expect(after!.tokenFingerprint).toBe(before!.tokenFingerprint)
  })

  it('⑪ a packaged build refuses the loopback deployment target (real DNS/SSRF policy)', async () => {
    // The real validateMcpDiscoveryUrl, not a stub: proves a shipped build will
    // not send a grant to a platform-supplied loopback address.
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    process.env.SUPERAGENT_IS_PACKAGED = '1'
    try {
      const status = await getCloudWorkspace()
      expect(status).toMatchObject({ available: true, found: false, discoveryFailed: true })
    } finally {
      process.env.SUPERAGENT_IS_PACKAGED = '0'
    }
    // …and it recovers once unpackaged again.
    const { getCloudWorkspace: again } = await import('@shared/lib/services/cloud-workspace-service')
    expect(await again()).toMatchObject({ found: true })
  })

  it('⑫ the deployment token minted through the pinned fetch is a real session', async () => {
    // Exercises the mcpSafeFetch path end to end: if the pinned undici agent
    // mangled the form POST, this token would not authenticate.
    const record = await readRecord()
    const res = await fetch(`${DEPLOYMENT_URL}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${record!.token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body?.user?.email).toBe(EMAIL)
  })

  it('⑬ an unreachable platform reports discoveryFailed, keeping the stored token', async () => {
    const { getCloudWorkspace } = await import('@shared/lib/services/cloud-workspace-service')
    const before = await readRecord()
    process.env.PLATFORM_PROXY_URL = 'http://127.0.0.1:59999'
    try {
      const status = await getCloudWorkspace()
      expect(status).toMatchObject({ available: true, found: false, discoveryFailed: true })
    } finally {
      process.env.PLATFORM_PROXY_URL = PROXY
    }
    const after = await readRecord()
    expect(after!.token).toBe(before!.token) // not wiped by a transient outage
  })

  it('⑧ discovery rejects an org-runtime JWT (member-bound requirement)', async () => {
    const orgToken = process.env.LIVE_ORG_RUNTIME_TOKEN
    if (!orgToken) return
    const { fetchDeployments, CloudWorkspaceError } = await import(
      '@shared/lib/platform-auth/cloud-workspace-client'
    )
    await expect(fetchDeployments(orgToken)).rejects.toBeInstanceOf(CloudWorkspaceError)
  })
})
