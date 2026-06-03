import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type GenerateKeyPairResult,
  type JSONWebKeySet,
} from 'jose'

const mockDbGet = vi.fn()
vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              get: mockDbGet,
            }),
          }),
        }),
      }),
    }),
  },
}))

import { clearSettingsCache, getSettings, updateSettings } from '@shared/lib/config/settings'
import { getAgentsDir } from '@shared/lib/utils/file-storage'
import type { SkillsetConfig, InstalledSkillMetadata, InstalledAgentMetadata } from '@shared/lib/types/skillset'

import {
  _resetEnvManagedPlatformStatusForTest,
  getPlatformAccessToken,
  getPlatformAuthStatus,
  initEnvManagedPlatformStatus,
  savePlatformAuth,
  refreshStoredPlatformAccount,
  revokePlatformToken,
  verifyPlatformOrgAccessTokenSigned,
} from './platform-auth-service'
import { _setOidcJwksResolverForTest } from '@shared/lib/auth/oidc-jwt'

const TEST_ISSUER = 'https://auth.test.example'
const TEST_KID = 'platform-oidc-main'
const TEST_AUDIENCE = 'platform-org-runtime'

let testKeyPair: GenerateKeyPairResult
let testJwksResolver: ReturnType<typeof createLocalJWKSet>

interface SignTokenOverrides {
  issuer?: string
  audience?: string
  expiresInSeconds?: number
  signWithKey?: GenerateKeyPairResult['privateKey']
  kid?: string
  omitOrgId?: boolean
}

async function signTestOrgToken(orgId: string, overrides: SignTokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const ttl = overrides.expiresInSeconds ?? 3600
  const payload: Record<string, unknown> = overrides.omitOrgId ? {} : { orgId }
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'JWT',
      kid: overrides.kid ?? TEST_KID,
    })
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(overrides.signWithKey ?? testKeyPair.privateKey)
}

beforeAll(async () => {
  testKeyPair = await generateKeyPair('RS256')
  const jwk = await exportJWK(testKeyPair.publicKey)
  const jwks: JSONWebKeySet = {
    keys: [{ ...jwk, alg: 'RS256', kid: TEST_KID, use: 'sig' }],
  }
  testJwksResolver = createLocalJWKSet(jwks)
})

describe('platform-auth-service', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-platform-auth-'))
    process.env.SUPERAGENT_DATA_DIR = tempDir
    process.env.AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        id: 'platform',
        type: 'oidc',
        issuer: TEST_ISSUER,
        clientId: 'superagent-test',
      },
    ])
    clearSettingsCache()
    _setOidcJwksResolverForTest(testJwksResolver as unknown as Parameters<typeof _setOidcJwksResolverForTest>[0])
    _resetEnvManagedPlatformStatusForTest()
    mockDbGet.mockReturnValue(null)
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tempDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
    delete process.env.AUTH_MODE
    delete process.env.PLATFORM_TOKEN
    delete process.env.PLATFORM_PROXY_URL
    delete process.env.AUTH_PROVIDERS_JSON
    _setOidcJwksResolverForTest(null)
    _resetEnvManagedPlatformStatusForTest()
    vi.restoreAllMocks()
  })

  it('falls back to PLATFORM_TOKEN env in auth mode when settings have no record', () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = 'env-managed-platform-token'

    expect(getPlatformAccessToken('local')).toBe('env-managed-platform-token')
  })

  it('returns null when not in auth mode and no settings record exists', () => {
    process.env.PLATFORM_TOKEN = 'should-be-ignored-when-auth-mode-off'
    delete process.env.AUTH_MODE

    expect(getPlatformAccessToken('local')).toBeNull()
  })

  it('returns env-managed status with verified orgId after init', async () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({
      connected: true,
      label: 'Managed by organization',
      orgId: 'org_env',
      source: 'env',
    })
  })

  it('warns and reports tokens with bad signature, returning orgId: null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const otherKey = await generateKeyPair('RS256')
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env', { signWithKey: otherKey.privateKey })

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({
      connected: true,
      orgId: null,
      source: 'env',
    })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[platform-auth] invalid PLATFORM_TOKEN: signature verification failed'),
    )
  })

  it('rejects tokens with the wrong issuer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env', { issuer: 'https://attacker.example' })

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({ orgId: null, source: 'env' })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[platform-auth] invalid PLATFORM_TOKEN: claim validation failed: iss'),
    )
  })

  it('rejects tokens with the wrong audience', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env', { audience: 'platform-other-runtime' })

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({ orgId: null, source: 'env' })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[platform-auth] invalid PLATFORM_TOKEN: claim validation failed: aud'),
    )
  })

  it('rejects expired tokens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env', { expiresInSeconds: -10 })

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({ orgId: null, source: 'env' })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[platform-auth] invalid PLATFORM_TOKEN: token expired'),
    )
  })

  it('rejects tokens missing orgId claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('placeholder', { omitOrgId: true })

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({ orgId: null, source: 'env' })
    expect(warn).toHaveBeenCalled()
  })

  it('warns when no issuer is configured and stores orgId: null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.AUTH_PROVIDERS_JSON
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')

    await initEnvManagedPlatformStatus()

    expect(getPlatformAuthStatus('local')).toMatchObject({ orgId: null, source: 'env' })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[platform-auth] invalid PLATFORM_TOKEN: no issuer configured'),
    )
  })

  it('verifyPlatformOrgAccessTokenSigned returns full claims for a valid token', async () => {
    const token = await signTestOrgToken('org_X')
    const verified = await verifyPlatformOrgAccessTokenSigned(token, { issuer: TEST_ISSUER })
    expect(verified).toMatchObject({ orgId: 'org_X', iss: TEST_ISSUER, aud: TEST_AUDIENCE, kid: TEST_KID })
  })

  it('uses env-managed platform token before saved settings in auth mode', async () => {
    await savePlatformAuth('local', {
      token: 'plat_settings_token_1234567890abcdef',
      orgId: 'org_settings',
    })
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')

    await initEnvManagedPlatformStatus()

    expect(getPlatformAccessToken('local')).toBe(process.env.PLATFORM_TOKEN)
    expect(getPlatformAuthStatus('local')).toMatchObject({
      orgId: 'org_env',
      source: 'env',
    })
  })

  it('stores a token and exposes only redacted status', async () => {
    const status = await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
    })

    expect(status).toMatchObject({
      connected: true,
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
    })
    expect(status.tokenPreview).toBe('plat_s...cdef')
    expect(getPlatformAccessToken('local')).toBe('plat_superagent_token_1234567890abcdef')

    const settingsPath = path.join(tempDir, 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(onDisk.platformAuth).toBeDefined()
    expect(onDisk.platformAuth.token).toBe('plat_superagent_token_1234567890abcdef')
  })

  it('persists and exposes platform userId and memberId', async () => {
    const status = await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      userId: 'auth_user_uuid_123',
      memberId: 'sub_member_456',
    })

    expect(status).toMatchObject({
      userId: 'auth_user_uuid_123',
      memberId: 'sub_member_456',
    })
    expect(getPlatformAuthStatus('local')).toMatchObject({
      userId: 'auth_user_uuid_123',
      memberId: 'sub_member_456',
    })
  })

  it('defaults userId and memberId to null when metadata is provided without them', async () => {
    // OAuth-path save (metadata present) from a platform that does not yet
    // return user_id/member_id — no introspection, fields stay null.
    await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      orgId: 'org_test_123',
    })

    expect(getPlatformAuthStatus('local')).toMatchObject({
      userId: null,
      memberId: null,
    })
  })

  it('introspects and enriches a token-only (manual paste) save', async () => {
    process.env.PLATFORM_PROXY_URL = 'http://proxy.test'
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          memberId: 'sub_member_1',
          orgId: 'org_resolved',
          orgName: 'Resolved Org',
          role: 'admin',
          userId: 'user_resolved',
          email: 'resolved@example.com',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const status = await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://proxy.test/v1/account',
      expect.objectContaining({
        headers: { Authorization: 'Bearer plat_superagent_token_1234567890abcdef' },
      }),
    )
    expect(status).toMatchObject({
      email: 'resolved@example.com',
      orgId: 'org_resolved',
      orgName: 'Resolved Org',
      role: 'admin',
      userId: 'user_resolved',
      memberId: 'sub_member_1',
    })
  })

  it('rejects an invalid token-only save with a clear error', async () => {
    process.env.PLATFORM_PROXY_URL = 'http://proxy.test'
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid or revoked access token' } }), {
        status: 401,
      }),
    )

    await expect(
      savePlatformAuth('local', { token: 'plat_bad_token_000000000000000000000000' }),
    ).rejects.toMatchObject({
      name: 'PlatformRequestError',
      status: 400,
      message: 'This access key is invalid or has been revoked.',
    })

    // Nothing should have been persisted for a rejected key.
    expect(getPlatformAuthStatus('local').connected).toBe(false)
  })

  it('refreshStoredPlatformAccount updates the record when identity changed', async () => {
    // Seed a record with metadata (orgId present → no introspection on save).
    await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      email: 'old@example.com',
      orgId: 'org_old',
      orgName: 'Old Org',
      role: 'member',
      userId: 'user_old',
      memberId: 'sub_old',
    })

    process.env.PLATFORM_PROXY_URL = 'http://proxy.test'
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          memberId: 'sub_new',
          orgId: 'org_new',
          orgName: 'New Org',
          role: 'admin',
          userId: 'user_new',
          email: 'new@example.com',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const updated = await refreshStoredPlatformAccount()
    expect(updated).toBe(true)
    expect(getPlatformAuthStatus('local')).toMatchObject({
      email: 'new@example.com',
      orgId: 'org_new',
      role: 'admin',
      userId: 'user_new',
      memberId: 'sub_new',
    })
  })

  it('refreshStoredPlatformAccount is a no-op when identity is unchanged', async () => {
    await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      email: 'same@example.com',
      orgId: 'org_same',
      orgName: 'Same Org',
      role: 'member',
      userId: 'user_same',
      memberId: 'sub_same',
    })
    const before = getPlatformAuthStatus('local').updatedAt

    process.env.PLATFORM_PROXY_URL = 'http://proxy.test'
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          memberId: 'sub_same',
          orgId: 'org_same',
          orgName: 'Same Org',
          role: 'member',
          userId: 'user_same',
          email: 'same@example.com',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const updated = await refreshStoredPlatformAccount()
    expect(updated).toBe(false)
    expect(getPlatformAuthStatus('local').updatedAt).toBe(before) // record not rewritten
  })

  // ---------------------------------------------------------------------------
  // OIDC account enrichment for env-managed deployments
  // ---------------------------------------------------------------------------

  function makeIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${header}.${payload}.fake-signature`
  }

  it('env-managed status returns userId from OIDC id_token when user_id claim is present', async () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')
    await initEnvManagedPlatformStatus()

    mockDbGet.mockReturnValue({
      idToken: makeIdToken({
        sub: 'sub_member_123',
        'https://platform.skillfulagents.dev/claims/user_id': 'uuid-platform-user',
      }),
    })

    const status = getPlatformAuthStatus('ba-user-id')
    expect(status.userId).toBe('uuid-platform-user')
    expect(status.source).toBe('env')
  })

  it('env-managed status returns userId: null when user_id claim is absent from id_token', async () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')
    await initEnvManagedPlatformStatus()

    mockDbGet.mockReturnValue({
      idToken: makeIdToken({ sub: 'sub_member_123' }),
    })

    const status = getPlatformAuthStatus('ba-user-id')
    expect(status.userId).toBeNull()
  })

  it('env-managed status returns userId: null when no platform account exists', async () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')
    await initEnvManagedPlatformStatus()

    mockDbGet.mockReturnValue(null)

    const status = getPlatformAuthStatus('ba-user-id')
    expect(status.userId).toBeNull()
  })

  it('env-managed status returns userId: null when no idToken is stored', async () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')
    await initEnvManagedPlatformStatus()

    mockDbGet.mockReturnValue({ idToken: null })

    const status = getPlatformAuthStatus('ba-user-id')
    expect(status.userId).toBeNull()
  })

  it('env-managed status does not query account table when no userId is provided', async () => {
    process.env.AUTH_MODE = 'true'
    process.env.PLATFORM_TOKEN = await signTestOrgToken('org_env')
    await initEnvManagedPlatformStatus()

    mockDbGet.mockClear()
    const status = getPlatformAuthStatus()
    expect(status.userId).toBeNull()
    expect(mockDbGet).not.toHaveBeenCalled()
  })

  // Helpers for the org-switch / lifecycle tests below.
  function makePlatformSkillset(id: string, orgId: string): SkillsetConfig {
    return {
      id,
      url: 'http://platform-proxy.test/v1/skills/repo',
      name: id,
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform',
      providerData: { repoId: id, orgId },
    }
  }

  function makeGithubSkillset(id: string): SkillsetConfig {
    return {
      id,
      url: `https://github.com/example/${id}.git`,
      name: id,
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'github',
    }
  }

  function writeInstalledSkill(
    agentSlug: string,
    skillDirName: string,
    meta: InstalledSkillMetadata,
  ): void {
    const dir = path.join(getAgentsDir(), agentSlug, 'workspace', '.claude', 'skills', skillDirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# test skill', 'utf-8')
    fs.writeFileSync(path.join(dir, '.skillset-metadata.json'), JSON.stringify(meta, null, 2), 'utf-8')
  }

  function writeInstalledTemplate(
    agentSlug: string,
    meta: InstalledAgentMetadata,
  ): void {
    const dir = path.join(getAgentsDir(), agentSlug, 'workspace')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.skillset-agent-metadata.json'), JSON.stringify(meta, null, 2), 'utf-8')
  }

  it('switching orgs removes configs + installed files for the previous org', async () => {
    await savePlatformAuth('local', {
      token: 'plat_test_token_oldorg_xxxxxxxx',
      orgId: 'org_old',
    })

    // Seed: one platform skillset + one github skillset + installed skills for both.
    const settings = getSettings()
    settings.skillsets = [
      makePlatformSkillset('platform--old', 'org_old'),
      makeGithubSkillset('github--keep'),
    ]
    updateSettings(settings)

    writeInstalledSkill('agent-a', 'old-org-skill', {
      skillsetId: 'platform--old',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      skillName: 'old-org-skill',
      skillPath: 'skills/old-org-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_old', repoId: 'platform--old' },
    })
    writeInstalledSkill('agent-a', 'github-skill', {
      skillsetId: 'github--keep',
      skillsetUrl: 'https://github.com/example/github--keep.git',
      skillName: 'github-skill',
      skillPath: 'skills/github-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'github',
    })
    writeInstalledTemplate('agent-a', {
      skillsetId: 'platform--old',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      agentName: 'agent-a',
      agentPath: 'agents/agent-a/',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_old', repoId: 'platform--old' },
    })

    // Switch to a new org.
    await savePlatformAuth('local', {
      token: 'plat_test_token_neworg_xxxxxxxx',
      orgId: 'org_new',
    })

    // Platform skillset for previous org is gone; github one is kept.
    const after = getSettings()
    expect(after.skillsets?.map((s) => s.id)).toEqual(['github--keep'])

    // Installed platform skill is gone; github skill is kept.
    const skillsDir = path.join(getAgentsDir(), 'agent-a', 'workspace', '.claude', 'skills')
    expect(fs.existsSync(path.join(skillsDir, 'old-org-skill'))).toBe(false)
    expect(fs.existsSync(path.join(skillsDir, 'github-skill'))).toBe(true)

    // Template metadata for the previous org is gone.
    const templateMeta = path.join(getAgentsDir(), 'agent-a', 'workspace', '.skillset-agent-metadata.json')
    expect(fs.existsSync(templateMeta)).toBe(false)
  })

  it('full disconnect removes all platform skillsets + installs', async () => {
    await savePlatformAuth('local', {
      token: 'plat_test_token_connected_xxx',
      orgId: 'org_x',
    })

    const settings = getSettings()
    settings.skillsets = [
      makePlatformSkillset('platform--x', 'org_x'),
      makeGithubSkillset('github--keep'),
    ]
    updateSettings(settings)

    writeInstalledSkill('agent-b', 'platform-skill', {
      skillsetId: 'platform--x',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      skillName: 'platform-skill',
      skillPath: 'skills/platform-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_x', repoId: 'platform--x' },
    })

    await revokePlatformToken({ clearLocal: true })

    const after = getSettings()
    expect(after.skillsets?.map((s) => s.id)).toEqual(['github--keep'])
    expect(fs.existsSync(
      path.join(getAgentsDir(), 'agent-b', 'workspace', '.claude', 'skills', 'platform-skill'),
    )).toBe(false)
  })

  it('lazy prune: reading a stale platform skill deletes the skill directory', async () => {
    // User is now logged into org_B but an install from org_A is still on disk.
    await savePlatformAuth('local', {
      token: 'plat_test_new_token_xxxxxxxxxxxx',
      orgId: 'org_B',
    })

    // Clear any settings cleanup side-effect so we can observe the lazy path
    // on the file-system level too.
    writeInstalledSkill('agent-c', 'stale-skill', {
      skillsetId: 'platform--prev',
      skillsetUrl: 'http://platform-proxy.test/v1/skills/repo',
      skillName: 'stale-skill',
      skillPath: 'skills/stale-skill/SKILL.md',
      installedVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      originalContentHash: 'abc',
      provider: 'platform',
      providerData: { orgId: 'org_A', repoId: 'platform--prev' },
    })

    // Lazy prune via the metadata reader.
    const { getInstalledSkillMetadata } = await import('./skillset-service')
    const result = await getInstalledSkillMetadata('agent-c', 'stale-skill')

    expect(result).toBeNull()
    const skillDir = path.join(
      getAgentsDir(), 'agent-c', 'workspace', '.claude', 'skills', 'stale-skill',
    )
    expect(fs.existsSync(skillDir)).toBe(false)
  })
})
