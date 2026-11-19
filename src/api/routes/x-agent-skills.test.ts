import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { DiscoverableSkill, SkillsetConfig } from '@shared/lib/types/skillset'

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => (token === 'agent-token' ? 'agent-a' : null),
}))

const mockGetSettings = vi.fn()
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))

const mockLogAuditEvent = vi.fn()
vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

const mockPullSkillsets = vi.fn()
const mockGetDiscoverableSkills = vi.fn()
const mockInstallDiscoverableSkill = vi.fn()
vi.mock('@shared/lib/services/skillset-service', () => ({
  BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS: 15 * 60_000,
  pullSkillsets: (...args: unknown[]) => mockPullSkillsets(...args),
  getDiscoverableSkills: (...args: unknown[]) => mockGetDiscoverableSkills(...args),
  installDiscoverableSkill: (...args: unknown[]) => mockInstallDiscoverableSkill(...args),
}))

const { default: router } = await import('./x-agent-skills')
const app = new Hono().route('/api/x-agent/skills', router)

const call = (path: string, body: unknown, token: string | null = 'agent-token') =>
  app.request(`/api/x-agent/skills${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const teamSkillset: SkillsetConfig = {
  id: 'platform--team--skills',
  url: 'https://platform.example/v1/skills/repo',
  name: 'Team Skills',
  description: '',
  addedAt: '2026-01-01T00:00:00Z',
  provider: 'platform',
}

const githubSkillset: SkillsetConfig = {
  id: 'github-com-acme-public',
  url: 'https://github.com/acme/public',
  name: 'Public Skills',
  description: '',
  addedAt: '2026-01-01T00:00:00Z',
  provider: 'github',
}

function makeSkill(index: number): DiscoverableSkill {
  return {
    skillsetId: teamSkillset.id,
    skillsetName: teamSkillset.name,
    name: `skill-${index}`,
    description: `Does task ${index}`,
    version: '1.0.0',
    path: `skills/skill-${index}/SKILL.md`,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSettings.mockResolvedValue({ skillsets: [teamSkillset, githubSkillset] })
  mockPullSkillsets.mockResolvedValue(undefined)
  mockGetDiscoverableSkills.mockResolvedValue([])
  mockInstallDiscoverableSkill.mockResolvedValue(null)
  mockLogAuditEvent.mockResolvedValue(undefined)
})

describe('authentication', () => {
  it('refuses search and install without a valid agent token', async () => {
    for (const [path, body] of [
      ['/search', {}],
      ['/install', { skillsetId: teamSkillset.id, skillPath: 'skills/a/SKILL.md' }],
    ] as const) {
      expect((await call(path, body, null)).status).toBe(401)
      expect((await call(path, body, 'bad-token')).status).toBe(401)
    }
    expect(mockPullSkillsets).not.toHaveBeenCalled()
    expect(mockInstallDiscoverableSkill).not.toHaveBeenCalled()
  })
})

describe('POST /search', () => {
  it('pulls only team skillsets, matches the query, and caps results at 25', async () => {
    const all = Array.from({ length: 30 }, (_, i) => makeSkill(i))
    mockGetDiscoverableSkills.mockResolvedValue(all)

    const res = await call('/search', { query: 'task' })

    expect(res.status).toBe(200)
    expect(mockPullSkillsets).toHaveBeenCalledWith([teamSkillset], { maxAgeMs: 15 * 60_000 })
    expect(mockGetDiscoverableSkills).toHaveBeenCalledWith('agent-a', [teamSkillset])
    const json = await res.json() as { skills: DiscoverableSkill[]; total: number }
    expect(json.total).toBe(30)
    expect(json.skills).toHaveLength(25)
  })
})

describe('POST /install', () => {
  it('installs from team skillsets only and logs an agent audit event', async () => {
    mockInstallDiscoverableSkill.mockResolvedValue({ name: 'Invoice Parser', directory: 'invoice-parser' })

    const res = await call('/install', { skillsetId: teamSkillset.id, skillPath: 'skills/invoice-parser/SKILL.md' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'Invoice Parser', directory: 'invoice-parser' })
    expect(mockInstallDiscoverableSkill).toHaveBeenCalledWith('agent-a', [teamSkillset], teamSkillset.id, 'skills/invoice-parser/SKILL.md')
    expect(mockLogAuditEvent).toHaveBeenCalledWith({
      object: 'skill',
      objectId: 'agent-a/skills/invoice-parser/SKILL.md',
      action: 'created',
      details: { skillsetId: teamSkillset.id, skillName: 'Invoice Parser', by: 'agent', agentSlug: 'agent-a' },
    })
  })

  it('returns 404 without logging an audit event when nothing was installed', async () => {
    const res = await call('/install', { skillsetId: githubSkillset.id, skillPath: 'skills/invoice-parser/SKILL.md' })

    expect(res.status).toBe(404)
    expect(mockLogAuditEvent).not.toHaveBeenCalled()
  })
})
