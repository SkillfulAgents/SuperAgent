import { beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  // SUP-312: routes now persist via the serialized fresh-read mutateSettings.
  // Faithfully reproduce its observable effect against the seeded mock settings
  // so existing assertions on mockUpdateSettings keep working.
  mutateSettings: (mutator: (s: Record<string, unknown>) => void) => {
    const s = structuredClone(mockGetSettings() ?? {})
    mutator(s)
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
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: (...args: unknown[]) => mockGetPlatformProxyBaseUrl(...args),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: (...args: unknown[]) => mockGetPlatformAccessToken(...args),
  getPlatformAuthStatus: (...args: unknown[]) => mockGetPlatformAuthStatus(...args),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

import skillsets from './skillsets'

describe('skillsets routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

    const body = await res.json() as Array<{ error?: string; skillCount: number }>
    expect(body[0].error).toBeUndefined()
    expect(body[0].skillCount).toBe(1)
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
    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith('https://github.com/Org/repo', 'public')
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

    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith('https://github.com/Org/repo', 'github')
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

    expect(mockValidateSkillsetUrl).toHaveBeenCalledWith('https://github.com/Org/repo', undefined)
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
})
