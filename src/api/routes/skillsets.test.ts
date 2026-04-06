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
const mockGetPlatformProxyBaseUrl = vi.fn()
const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformAuthStatus = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
}))

vi.mock('@shared/lib/services/skillset-service', () => ({
  validateSkillsetUrl: (...args: unknown[]) => mockValidateSkillsetUrl(...args),
  urlToSkillsetId: (...args: unknown[]) => mockUrlToSkillsetId(...args),
  refreshSkillset: (...args: unknown[]) => mockRefreshSkillset(...args),
  getSkillsetIndex: (...args: unknown[]) => mockGetSkillsetIndex(...args),
  removeSkillsetCache: (...args: unknown[]) => mockRemoveSkillsetCache(...args),
  ensureSkillsetCached: (...args: unknown[]) => mockEnsureSkillsetCached(...args),
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

  it('lists only platform skillsets from the current org', async () => {
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
          platformRepoId: 'repo-current',
          platformOrgId: 'org_current',
        },
        {
          id: 'platform--repo-old--legacy',
          url: 'http://platform/v1/skills/repo',
          name: 'legacy',
          description: 'Old org legacy',
          addedAt: '2026-01-01T00:00:00.000Z',
          provider: 'platform',
          platformRepoId: 'repo-old',
          platformOrgId: 'org_old',
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

  it('backfills platformOrgId when syncing existing platform skillsets', async () => {
    const existingSettings = {
      skillsets: [
        {
          id: 'platform--repo-current--local',
          url: 'http://platform-proxy.test/v1/skills/repo',
          name: 'local',
          description: '',
          addedAt: '2026-01-01T00:00:00.000Z',
          provider: 'platform',
          platformRepoId: 'repo-current',
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

    const res = await app.request('/api/skillsets/sync-platform', { method: 'POST' })
    expect(res.status).toBe(200)

    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
    const updatedSettings = mockUpdateSettings.mock.calls[0][0]
    expect(updatedSettings.skillsets[0]).toMatchObject({
      id: 'platform--repo-current--local',
      platformRepoId: 'repo-current',
      platformOrgId: 'org_current',
      description: 'Current org local',
    })

    vi.unstubAllGlobals()
  })
})
