import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockGetSettings = vi.fn()
const mockUpdateSettings = vi.fn()
const mockValidateSkillsetUrl = vi.fn()
const mockUrlToSkillsetId = vi.fn()
const mockRefreshSkillset = vi.fn()
const mockGetSkillsetIndex = vi.fn()
const mockRemoveSkillsetCache = vi.fn()
const mockEnsureSkillsetCached = vi.fn()
const mockIsGitAvailable = vi.fn()
const mockGetPlatformProxyBaseUrl = vi.fn()
const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformAuthStatus = vi.fn()
/** How many discarded attempts the mocked mutateSettings runs before the committed one. */
const mutateRetries = vi.hoisted(() => ({ count: 0 }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async (...args: unknown[]) => mockGetSettings(...args),
  // routes persist via the compare-and-set mutateSettings. Reproduce its
  // observable effect against the seeded mock settings (mockUpdateSettings
  // records each committed write), including a retry: the mutator runs again
  // on a fresh copy when `mutateRetries` asks for it.
  mutateSettings: async (mutator: (s: Record<string, unknown>) => void | false) => {
    for (let attempt = 0; attempt < mutateRetries.count; attempt++) {
      mutator(structuredClone(mockGetSettings() ?? {}))
    }
    const s = structuredClone(mockGetSettings() ?? {})
    if (mutator(s) === false) return s
    mockUpdateSettings(s)
    return s
  },
}))

vi.mock('@shared/lib/services/skillset-service', () => ({
  validateSkillsetUrl: (...args: unknown[]) => mockValidateSkillsetUrl(...args),
  urlToSkillsetId: (...args: unknown[]) => mockUrlToSkillsetId(...args),
  refreshSkillset: (...args: unknown[]) => mockRefreshSkillset(...args),
  getSkillsetIndex: (...args: unknown[]) => mockGetSkillsetIndex(...args),
  removeSkillsetCache: (...args: unknown[]) => mockRemoveSkillsetCache(...args),
  ensureSkillsetCached: (...args: unknown[]) => mockEnsureSkillsetCached(...args),
  isGitAvailable: (...args: unknown[]) => mockIsGitAvailable(...args),
  HOST_GIT_UNAVAILABLE: 'This needs git, which the Mac App Store edition can’t run.',
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: (...args: unknown[]) => mockGetPlatformProxyBaseUrl(...args),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: async (...args: unknown[]) => mockGetPlatformAccessToken(...args),
  getPlatformAuthStatus: async (...args: unknown[]) => mockGetPlatformAuthStatus(...args),
  // The pure form the provider applies to the settings a mutator hands it.
  platformAuthStatusFrom: (...args: unknown[]) => mockGetPlatformAuthStatus(...args),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

import skillsets from './skillsets'

describe('skillsets routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutateRetries.count = 0
    mockGetPlatformAuthStatus.mockReturnValue({
      connected: true,
      source: 'settings',
      tokenPreview: 'plat_s...1234',
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_current',
      orgName: 'Current Org',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    mockGetSkillsetIndex.mockResolvedValue({ skills: [], agents: [] })
    mockGetPlatformProxyBaseUrl.mockReturnValue('http://platform-proxy.test')
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_test')
    mockEnsureSkillsetCached.mockResolvedValue(undefined)
  })

  it('lists all configured skillsets (filtering happens at write-time, not query-time)', async () => {
    mockGetSettings.mockReturnValue({
      skillsets: [
        {
          id: 'github-demo',
          url: 'https://github.com/demo/repo',
          name: 'github-demo',
          description: 'GitHub skillset',
          addedAt: '2026-01-01T00:00:00.000Z',
          provider: 'github',
        },
        {
          id: 'platform--repo-current--local',
          url: 'http://platform/v1/skills/repo',
          name: 'local',
          description: 'Current org local',
          addedAt: '2026-01-01T00:00:00.000Z',
          provider: 'platform',
          providerData: {
            repoId: 'repo-current',
            orgId: 'org_current',
          },
        },
      ],
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)

    const res = await app.request('/api/skillsets')
    expect(res.status).toBe(200)

    const body = await res.json() as Array<{ id: string }>
    expect(body.map((item) => item.id)).toEqual([
      'github-demo',
      'platform--repo-current--local',
    ])
  })

  it('backfills providerData access fields when syncing existing platform skillsets', async () => {
    const existingSettings = {
      skillsets: [
        {
          id: 'platform--repo-current--local',
          url: 'http://platform-proxy.test/v1/skills/repo',
          name: 'local',
          description: '',
          addedAt: '2026-01-01T00:00:00.000Z',
          provider: 'platform',
          providerData: {
            repoId: 'repo-current',
          },
        },
      ],
    }
    mockGetSettings.mockReturnValue(existingSettings)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skillsets: [
          {
            name: 'local',
            path: 'local',
            repoId: 'repo-current',
            description: 'Current org local',
            skill_count: 1,
            agent_count: 0,
          },
        ],
      }),
    }))

    const app = new Hono()
    app.route('/api/skillsets', skillsets)

    const res = await app.request('/api/skillsets/sync-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'platform' }),
    })
    expect(res.status).toBe(200)

    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const updatedSettings = mockUpdateSettings.mock.calls[0][0]
    expect(updatedSettings.skillsets[0]).toMatchObject({
      id: 'platform--repo-current--local',
      description: 'Current org local',
      providerData: {
        repoId: 'repo-current',
        orgId: 'org_current',
      },
    })

    vi.unstubAllGlobals()
  })

  it('sync-remote reports each added skillset once when the settings write retries', async () => {
    mockGetSettings.mockReturnValue({ skillsets: [] })
    mutateRetries.count = 2
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        skillsets: [
          { name: 'alpha', path: 'alpha', repoId: 'repo-1', description: '', skill_count: 1, agent_count: 0 },
          { name: 'beta', path: 'beta', repoId: 'repo-1', description: '', skill_count: 1, agent_count: 0 },
        ],
      }),
    }))

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets/sync-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'platform' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ synced: 2, skillsets: ['alpha', 'beta'] })
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    expect(mockUpdateSettings.mock.calls[0][0].skillsets.map((s: { id: string }) => s.id)).toEqual([
      'platform--repo-1--alpha',
      'platform--repo-1--beta',
    ])

    vi.unstubAllGlobals()
  })

  it('GET / surfaces error when ensureSkillsetCached fails for uncached skillset', async () => {
    mockGetSettings.mockReturnValue({
      skillsets: [{
        id: 'bad-skillset',
        url: 'https://github.com/Org/missing',
        name: 'Missing',
        description: '',
        addedAt: '2026-01-01T00:00:00.000Z',
        provider: 'public',
      }],
    })
    mockGetSkillsetIndex.mockResolvedValue(null)
    mockEnsureSkillsetCached.mockRejectedValue(new Error('Repository not found'))

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets')

    expect(res.status).toBe(200)
    const body = await res.json() as Array<{ id: string; error?: string; skillCount: number }>
    expect(body).toHaveLength(1)
    expect(body[0].error).toBe('Repository not found')
    expect(body[0].skillCount).toBe(0)
  })

  it('GET / returns no error for healthy cached skillset', async () => {
    mockGetSettings.mockReturnValue({
      skillsets: [{
        id: 'ok-skillset',
        url: 'https://github.com/Org/repo',
        name: 'OK',
        description: '',
        addedAt: '2026-01-01T00:00:00.000Z',
        provider: 'github',
      }],
    })
    mockGetSkillsetIndex.mockResolvedValue({ skills: [{ name: 'a' }], agents: [] })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets')

    const body = await res.json() as Array<{ error?: string; skillCount: number; publishMode: string }>
    expect(body[0].error).toBeUndefined()
    expect(body[0].skillCount).toBe(1)
    expect(body[0].publishMode).toBe('pull_request')
  })

  describe('in the Mac App Store edition, which can’t run git', () => {
    beforeEach(() => {
      vi.stubEnv('E2E_MOCK', 'true')
      vi.stubEnv('SUPERAGENT_FAKE_DISTRIBUTION', 'mac-app-store')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('GET / offers no pull requests to a GitHub skillset', async () => {
      mockGetSettings.mockReturnValue({
        skillsets: [{ id: 'gh', url: 'https://github.com/Org/repo', name: 'GH', description: '', addedAt: '2026-01-01T00:00:00.000Z', provider: 'github' }],
      })
      mockGetSkillsetIndex.mockResolvedValue({ skills: [], agents: [] })

      const app = new Hono()
      app.route('/api/skillsets', skillsets)
      const body = await (await app.request('/api/skillsets')).json() as Array<{ publishMode: string }>

      expect(body[0].publishMode).toBe('none')
    })

    it('POST / refuses a private repository token before validating anything', async () => {
      mockGetSettings.mockReturnValue({ skillsets: [] })
      const app = new Hono()
      app.route('/api/skillsets', skillsets)
      const res = await app.request('/api/skillsets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/Org/private-repo', token: 'github_pat_x_1234' }),
      })

      expect(await res.json()).toEqual({ error: 'This needs git, which the Mac App Store edition can’t run.' })
      expect(mockValidateSkillsetUrl).not.toHaveBeenCalled()
      expect(mockUpdateSettings).not.toHaveBeenCalled()
    })
  })

  it('POST /validate auto-detects public provider when git is unavailable', async () => {
    mockIsGitAvailable.mockResolvedValue(false)
    mockValidateSkillsetUrl.mockResolvedValue({
      skillset_name: 'Test', skills: [], description: '', version: '1.0.0',
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/Org/repo' }),
    })

    expect(res.status).toBe(200)
    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith('https://github.com/Org/repo', 'public', undefined)
  })

  it('POST /validate does not override explicit provider', async () => {
    mockIsGitAvailable.mockResolvedValue(false)
    mockValidateSkillsetUrl.mockResolvedValue({
      skillset_name: 'Test', skills: [], description: '', version: '1.0.0',
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    await app.request('/api/skillsets/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/Org/repo', provider: 'github' }),
    })

    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith('https://github.com/Org/repo', 'github', undefined)
  })

  it('POST /validate falls through to default when git is available', async () => {
    mockIsGitAvailable.mockResolvedValue(true)
    mockValidateSkillsetUrl.mockResolvedValue({
      skillset_name: 'Test', skills: [], description: '', version: '1.0.0',
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    await app.request('/api/skillsets/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/Org/repo' }),
    })

    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith('https://github.com/Org/repo', undefined, undefined)
  })

  it('POST / saves resolved provider in config', async () => {
    mockIsGitAvailable.mockResolvedValue(false)
    mockUrlToSkillsetId.mockReturnValue('github-com-org-repo')
    mockGetSettings.mockReturnValue({ skillsets: [] })
    mockValidateSkillsetUrl.mockResolvedValue({
      skillset_name: 'Test', skills: [{ name: 'a' }], description: 'desc', version: '1.0.0',
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/Org/repo' }),
    })

    expect(res.status).toBe(201)
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const saved = mockUpdateSettings.mock.calls[0][0]
    expect(saved.skillsets[0].provider).toBe('public')
  })

  it('POST / stores a private repository token separately and never returns it', async () => {
    const token = 'github_pat_private_test_1234'
    let settingsState: Record<string, unknown> = { skillsets: [], skillsetCredentials: {} }
    mockUrlToSkillsetId.mockReturnValue('github-com-org-private-repo')
    mockGetSettings.mockImplementation(() => settingsState)
    mockUpdateSettings.mockImplementation((next) => { settingsState = next })
    mockValidateSkillsetUrl.mockResolvedValue({
      skillset_name: 'Private', skills: [{ name: 'a' }], description: 'desc', version: '1.0.0',
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/Org/private-repo', token }),
    })

    expect(res.status).toBe(201)
    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith(
      'https://github.com/Org/private-repo',
      'github',
      { type: 'token', token },
    )

    const saved = mockUpdateSettings.mock.calls[0][0]
    const credentialId = saved.skillsets[0].providerData.credentialId
    expect(credentialId).toMatch(/^skillcred_/)
    expect(saved.skillsetCredentials[credentialId]).toMatchObject({
      type: 'token',
      token,
      tokenPreview: '••••1234',
    })
    expect(saved.skillsets[0].url).toBe('https://github.com/Org/private-repo')
    const responseBody = JSON.stringify(await res.json())
    expect(responseBody).not.toContain(token)
    expect(responseBody).toContain('••••1234')
  })

  it('PATCH /:id/credential validates and rotates a token without changing its opaque id', async () => {
    const oldToken = 'github_pat_old_1111'
    const newToken = 'github_pat_new_2222'
    let settingsState: any = {
      skillsets: [{
        id: 'private-repo',
        url: 'https://github.com/Org/private-repo',
        name: 'Private',
        description: '',
        addedAt: '2026-01-01T00:00:00.000Z',
        provider: 'github',
        providerData: { credentialId: 'skillcred_test' },
      }],
      skillsetCredentials: {
        skillcred_test: {
          id: 'skillcred_test', type: 'token', token: oldToken, tokenPreview: '••••1111',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    mockGetSettings.mockImplementation(() => settingsState)
    mockUpdateSettings.mockImplementation((next) => { settingsState = next })
    mockValidateSkillsetUrl.mockResolvedValue({
      skillset_name: 'Private', skills: [{ name: 'a' }], description: '', version: '1.0.0',
    })
    mockGetSkillsetIndex.mockResolvedValue({ skills: [{ name: 'a' }], agents: [] })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets/private-repo/credential', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: newToken }),
    })

    expect(res.status).toBe(200)
    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith(
      'https://github.com/Org/private-repo',
      'github',
      { type: 'token', token: newToken },
    )
    expect(settingsState.skillsets[0].providerData.credentialId).toBe('skillcred_test')
    expect(settingsState.skillsetCredentials.skillcred_test).toMatchObject({
      token: newToken,
      tokenPreview: '••••2222',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const responseBody = JSON.stringify(await res.json())
    expect(responseBody).not.toContain(oldToken)
    expect(responseBody).not.toContain(newToken)
    expect(responseBody).toContain('••••2222')
  })

  it('PATCH /:id/credential returns 404 when the skillset is deleted concurrently', async () => {
    const settingsState: Record<string, unknown> = {
      skillsets: [{
        id: 'private-repo',
        url: 'https://github.com/Org/private-repo',
        name: 'Private',
        description: '',
        addedAt: '2026-01-01T00:00:00.000Z',
        provider: 'github',
        providerData: { credentialId: 'skillcred_test' },
      }],
      skillsetCredentials: {
        skillcred_test: {
          id: 'skillcred_test', type: 'token', token: 'secret', tokenPreview: '••••cret',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    // Another writer deletes it after the route's first read, before its write.
    mockGetSettings
      .mockReturnValueOnce(settingsState)
      .mockReturnValue({ skillsets: [], skillsetCredentials: {} })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets/private-repo/credential', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: null }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Skillset not found' })
    expect(mockUpdateSettings).not.toHaveBeenCalled()
  })

  describe('settings reads', () => {
    const credentialBearing = (n: number) => {
      const skillsets = Array.from({ length: n }, (_, i) => ({
        id: `private-${i}`,
        url: `https://github.com/Org/private-${i}`,
        name: `Private ${i}`,
        description: '',
        addedAt: '2026-01-01T00:00:00.000Z',
        provider: 'github',
        providerData: { credentialId: `skillcred_${i}` },
      }))
      const skillsetCredentials = Object.fromEntries(skillsets.map((_, i) => [`skillcred_${i}`, {
        id: `skillcred_${i}`, type: 'token', token: `github_pat_${i}`, tokenPreview: `••••000${i}`,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }]))
      return { skillsets, skillsetCredentials }
    }

    it('GET / reads settings once, however many credential-bearing skillsets it lists', async () => {
      const app = new Hono()
      app.route('/api/skillsets', skillsets)
      const readsFor = async (n: number) => {
        mockGetSettings.mockReset()
        mockGetSettings.mockReturnValue(credentialBearing(n))
        const body = await (await app.request('/api/skillsets')).json() as Array<{ credential?: { tokenPreview: string } }>
        expect(body.map((item) => item.credential?.tokenPreview)).toEqual(
          Array.from({ length: n }, (_, i) => `••••000${i}`),
        )
        return mockGetSettings.mock.calls.length
      }

      expect(await readsFor(1)).toBe(1)
      expect(await readsFor(6)).toBe(1)
    })

    it('PATCH /:id/credential answers from the settings its write committed', async () => {
      let settingsState: any = credentialBearing(1)
      mockGetSettings.mockImplementation(() => settingsState)
      mockUpdateSettings.mockImplementation((next) => { settingsState = next })
      mockValidateSkillsetUrl.mockResolvedValue({ skillset_name: 'Renamed', skills: [], description: '', version: '1.0.0' })

      const app = new Hono()
      app.route('/api/skillsets', skillsets)
      const res = await app.request('/api/skillsets/private-0/credential', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'github_pat_rotated_9999' }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ name: 'Renamed', credential: { tokenPreview: '••••9999' } })
      // The route's own read, then the write's.
      expect(mockGetSettings).toHaveBeenCalledTimes(2)
      // Rotated in place: same opaque id and creation time, from the write's own draft.
      expect(settingsState.skillsetCredentials.skillcred_0).toMatchObject({
        id: 'skillcred_0', token: 'github_pat_rotated_9999', createdAt: '2026-01-01T00:00:00.000Z',
      })
    })

    it('sync-remote judges every remote skillset against one auth state per write attempt', async () => {
      const app = new Hono()
      app.route('/api/skillsets', skillsets)
      const authDerivationsFor = async (remotes: number, retries: number) => {
        mutateRetries.count = retries
        mockGetSettings.mockReturnValue({ skillsets: [] })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            skillsets: Array.from({ length: remotes }, (_, i) => ({
              name: `s${i}`, path: `s${i}`, repoId: 'repo-1', description: '', skill_count: 1, agent_count: 0,
            })),
          }),
        }))
        mockGetPlatformAuthStatus.mockClear()
        const res = await app.request('/api/skillsets/sync-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'platform' }),
        })
        expect(await res.json()).toMatchObject({ synced: remotes })
        vi.unstubAllGlobals()
        // Less the one status read of the sync preconditions.
        return mockGetPlatformAuthStatus.mock.calls.length - 1
      }

      expect(await authDerivationsFor(1, 0)).toBe(1)
      expect(await authDerivationsFor(5, 0)).toBe(1)
      // A retried write derives it again from its own, newer draft.
      expect(await authDerivationsFor(5, 2)).toBe(3)
    })
  })

  it('DELETE / removes the credential owned by the skillset', async () => {
    const config = {
      id: 'private-repo',
      url: 'https://github.com/Org/private-repo',
      name: 'Private',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'github' as const,
      providerData: { credentialId: 'skillcred_test' },
    }
    mockGetSettings.mockReturnValue({
      skillsets: [config],
      skillsetCredentials: {
        skillcred_test: {
          id: 'skillcred_test', type: 'token', token: 'secret', tokenPreview: '••••cret',
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    const app = new Hono()
    app.route('/api/skillsets', skillsets)
    const res = await app.request('/api/skillsets/private-repo', { method: 'DELETE' })

    expect(res.status).toBe(204)
    const saved = mockUpdateSettings.mock.calls[0][0]
    expect(saved.skillsets).toEqual([])
    expect(saved.skillsetCredentials).toEqual({})
  })
})
