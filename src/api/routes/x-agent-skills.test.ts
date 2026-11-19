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

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

const mockReviewRequest = vi.fn()
const mockReviewWithdraw = vi.fn()
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      inputs: {
        reviews: {
          request: (...args: unknown[]) => mockReviewRequest(...args),
          withdraw: (...args: unknown[]) => mockReviewWithdraw(...args),
          resume: vi.fn(),
          settle: vi.fn(),
          takeDecisionDetail: vi.fn(async () => ({})),
        },
      },
    }),
  },
}))

class FakeSkillPublishRefusal extends Error {}

const mockPullSkillsets = vi.fn()
const mockGetDiscoverableSkills = vi.fn()
const mockInstallDiscoverableSkill = vi.fn()
const mockPlanTeamSkillPublish = vi.fn()
const mockPublishPlannedTeamSkill = vi.fn()
vi.mock('@shared/lib/services/skillset-service', () => ({
  BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS: 15 * 60_000,
  SkillPublishRefusal: FakeSkillPublishRefusal,
  pullSkillsets: (...args: unknown[]) => mockPullSkillsets(...args),
  getDiscoverableSkills: (...args: unknown[]) => mockGetDiscoverableSkills(...args),
  installDiscoverableSkill: (...args: unknown[]) => mockInstallDiscoverableSkill(...args),
  planTeamSkillPublish: (...args: unknown[]) => mockPlanTeamSkillPublish(...args),
  publishPlannedTeamSkill: (...args: unknown[]) => mockPublishPlannedTeamSkill(...args),
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

const samplePlan = {
  skillName: 'Invoice Parser',
  skillDirectory: 'invoice-parser',
  skillsetId: teamSkillset.id,
  skillsetName: teamSkillset.name,
  description: 'Read fields from invoice PDFs',
  files: ['SKILL.md'],
  updatesPublishedSkill: false,
  packageHash: 'hash-1',
}

const publishBody = {
  skillDirectory: 'invoice-parser',
  title: 'Add invoice-parser',
  note: 'Reads invoice PDFs',
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

async function submitAndWait(body: unknown = publishBody) {
  const start = await call('/publish', body)
  expect(start.status).toBe(202)
  const { proposalId } = await start.json() as { proposalId: string }
  return call('/wait', { proposalId })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSettings.mockResolvedValue({ skillsets: [teamSkillset, githubSkillset] })
  mockPullSkillsets.mockResolvedValue(undefined)
  mockGetDiscoverableSkills.mockResolvedValue([])
  mockInstallDiscoverableSkill.mockResolvedValue(null)
  mockPlanTeamSkillPublish.mockResolvedValue(samplePlan)
  mockReviewRequest.mockResolvedValue('allow')
  mockPublishPlannedTeamSkill.mockResolvedValue({ successMessage: 'Changes submitted successfully.' })
  mockLogAuditEvent.mockResolvedValue(undefined)
})

describe('authentication', () => {
  it('refuses every route without a valid agent token', async () => {
    for (const [path, body] of [
      ['/search', {}],
      ['/install', { skillsetId: teamSkillset.id, skillPath: 'skills/a/SKILL.md' }],
      ['/publish', publishBody],
      ['/wait', { proposalId: 'p1' }],
      ['/cancel', { proposalId: 'p1' }],
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

describe('POST /publish, /wait, /cancel', () => {
  it('raises a review card, publishes after approval, and audits the published outcome', async () => {
    const res = await submitAndWait()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message: 'Changes submitted successfully.' })
    expect(mockReviewRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: teamSkillset.id,
        matchedScopes: [],
        skillPublish: expect.objectContaining({ skillName: 'Invoice Parser', skillDirectory: 'invoice-parser' }),
      }),
      expect.any(Object),
    )
    expect(mockPublishPlannedTeamSkill).toHaveBeenCalledWith(
      'agent-a',
      samplePlan,
      [teamSkillset],
      { title: publishBody.title, body: publishBody.note },
    )
    expect(mockLogAuditEvent).toHaveBeenCalledWith({
      object: 'skill',
      objectId: 'agent-a/invoice-parser',
      action: 'exported',
      details: expect.objectContaining({ skillsetId: teamSkillset.id, by: 'agent', outcome: 'published' }),
    })
  })

  it('returns 422 without raising a card or auditing when planning refuses the skill', async () => {
    mockPlanTeamSkillPublish.mockRejectedValue(new FakeSkillPublishRefusal('This skill has no changes to publish.'))

    const res = await submitAndWait()

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'cannot_publish', message: 'This skill has no changes to publish.' })
    expect(mockReviewRequest).not.toHaveBeenCalled()
    expect(mockLogAuditEvent).not.toHaveBeenCalled()
  })

  it('returns 403 without publishing or auditing when the user rejects', async () => {
    mockReviewRequest.mockResolvedValue('deny')

    const res = await submitAndWait()

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'denied_by_user' })
    expect(mockPublishPlannedTeamSkill).not.toHaveBeenCalled()
    expect(mockLogAuditEvent).not.toHaveBeenCalled()
  })

  it('returns 408 without publishing or auditing when the review times out', async () => {
    mockReviewRequest.mockResolvedValue('timeout')

    const res = await submitAndWait()

    expect(res.status).toBe(408)
    expect(await res.json()).toMatchObject({ error: 'review_timeout' })
    expect(mockPublishPlannedTeamSkill).not.toHaveBeenCalled()
    expect(mockLogAuditEvent).not.toHaveBeenCalled()
  })

  it('returns 409 and audits not_published when the skill changed after approval', async () => {
    mockPublishPlannedTeamSkill.mockRejectedValue(new FakeSkillPublishRefusal('The skill changed after the approval was asked for.'))

    const res = await submitAndWait()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_published' })
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'exported',
      details: expect.objectContaining({ outcome: 'not_published' }),
    }))
  })

  it('returns 500 and audits failed when publishing throws after approval', async () => {
    mockPublishPlannedTeamSkill.mockRejectedValue(new Error('network down'))

    const res = await submitAndWait()

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'publish_failed' })
    expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'exported',
      details: expect.objectContaining({ outcome: 'failed' }),
    }))
  })

  it('caps concurrent pending publishes at 3 and withdraws one on /cancel', async () => {
    const settlers: Array<(outcome: 'withdrawn') => void> = []
    mockReviewRequest.mockImplementation(() => new Promise<'withdrawn'>((resolve) => { settlers.push(resolve) }))
    mockReviewWithdraw.mockImplementation(() => { settlers.shift()?.('withdrawn') })

    const ids: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const start = await call('/publish', publishBody)
      expect(start.status).toBe(202)
      ids.push((await start.json() as { proposalId: string }).proposalId)
    }

    const fourth = await call('/publish', publishBody)
    expect(fourth.status).toBe(429)
    expect(await fourth.json()).toMatchObject({ error: 'too_many_pending' })

    for (const proposalId of ids) {
      const cancelled = await call('/cancel', { proposalId })
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toEqual({ ok: true })
    }
    while (settlers.length > 0) settlers.shift()?.('withdrawn')
  })
})
