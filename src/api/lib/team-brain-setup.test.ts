import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const { VolumeErrorFake } = vi.hoisted(() => ({ VolumeErrorFake: class extends Error { status = 404 } }))
vi.mock('@shared/lib/volumes/volume-error', () => ({ VolumeError: VolumeErrorFake }))

const world = vi.hoisted(() => ({
  agents: new Set<string>(),
  drives: new Map<string, { agents: Set<string>; global: string | null }>(),
  installs: 0,
  driveCount: 0,
  installFails: false,
  policies: new Set<string>(),
  tasks: [] as { id: string; name: string; scheduleExpression: string }[],
  instructions: '- **Maintenance schedule:** `{{schedule}}`\n- **Brain location:** `{{brain_path}}`',
  granted: [] as string[],
  visible: [] as string[],
  /** Agents that exist but the finishing admin's list does not show. */
  hidden: [] as string[],
  auth: false,
  failInstructions: false,
  mountFails: false,
  duringInstructions: null as null | (() => Promise<unknown>),
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => world.auth }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'admin-b' }))
vi.mock('@shared/lib/skillset-provider/default-public-skillset', () => ({ DEFAULT_PUBLIC_SKILLSET: { id: 'gamut-public' } }))
vi.mock('@shared/lib/services/skillset-service', () => ({ toSkillsetRefFromConfig: (c: unknown) => c, ensureSkillsetCached: async () => '' }))
vi.mock('@shared/lib/agent-actor', () => ({ agentCatalog: { list: async () => [...world.visible, ...world.hidden, ...world.agents] } }))
vi.mock('@shared/lib/services/notification-service', () => ({ accessibleAgents: () => ({ all: async () => world.visible.map((agentSlug) => ({ agentSlug })) }) }))
vi.mock('@shared/lib/services/agent-template-service', () => ({
  getDiscoverableAgents: async () => [{ path: 'agents/team-brain/', name: 'Team Brain', version: '1' }],
  hasOnboardingSkill: async () => ({ hasOnboarding: true, firstPrompt: 'hello' }),
  installAgentFromSkillset: async () => {
    // Another request's install yields here, so a concurrent step 1 has a window to race in.
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (world.installFails) throw new Error('clone failed')
    world.installs++
    const slug = `brain-${world.installs}`
    world.agents.add(slug)
    return { slug }
  },
}))
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: async (slug: string) => world.agents.has(slug),
  getAgent: async () => ({ instructions: world.instructions }),
  updateAgent: async (_slug: string, { instructions }: { instructions: string }) => {
    if (world.failInstructions) throw new Error('disk full')
    await world.duringInstructions?.()
    world.instructions = instructions
  },
}))
vi.mock('@shared/lib/services/mount-service', () => ({
  addMount: async (slug: string) => {
    if (world.mountFails) throw new Error('bad repo')
    const volumeId = `drive-${++world.driveCount}`
    world.drives.set(volumeId, { agents: new Set([slug]), global: null })
    return { volumeId, name: 'Team Brain' }
  },
  attachMount: async (slug: string, volumeId: string) => { world.drives.get(volumeId)!.agents.add(slug) },
  removeMount: async (slug: string, mountId: string) => { world.drives.get(mountId)?.agents.delete(slug) },
  getMounts: async (slug: string) => [...world.drives].filter(([, d]) => d.agents.has(slug)).map(([volumeId]) => ({ volumeId, name: 'Team Brain' })),
}))
vi.mock('@shared/lib/services/volume-service', () => ({
  listVolumeAttachments: async (volumeId: string) => [...(world.drives.get(volumeId)?.agents ?? [])].map((agentSlug) => ({ agentSlug, mountId: volumeId })),
  releaseVolume: async (volumeId: string) => { world.drives.get(volumeId)?.agents.clear(); return [] },
  deleteVolumeDefinition: async (volumeId: string) => { world.drives.delete(volumeId) },
  updateVolumeDefinition: async (volumeId: string, { global }: { global: string | null }) => { world.drives.get(volumeId)!.global = global },
}))
vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  setPolicy: async (caller: string, op: string, target: string | null) => { world.policies.add(`${caller} ${op} ${target}`) },
  deletePolicy: async (caller: string, op: string, target: string | null) => { world.policies.delete(`${caller} ${op} ${target}`) },
}))
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  listPendingScheduledTasks: async () => world.tasks,
  createScheduledTask: async ({ name, scheduleExpression }: { name: string; scheduleExpression: string }) => {
    world.tasks.push({ id: `task-${world.tasks.length + 1}`, name, scheduleExpression })
    return `task-${world.tasks.length}`
  },
  updateScheduleExpression: async (id: string, expression: string) => { world.tasks.find((t) => t.id === id)!.scheduleExpression = expression },
}))
vi.mock('@shared/lib/services/timezone-resolver', () => ({ resolveTimezoneForAgent: async () => 'UTC' }))
vi.mock('@shared/lib/notifications/global-feed', () => ({ globalFeed: { publish: () => {} } }))
vi.mock('@shared/lib/services/agent-members-service', () => ({ addAgentUsers: async (slug: string) => { world.granted.push(slug) } }))
vi.mock('./mount-change', () => ({ afterMountChange: async () => {} }))
vi.mock('./owner-acl', () => ({ createOwnerAclOrRollback: async () => {} }))
vi.mock('./remove-agent', () => ({ removeAgent: async (slug: string) => world.agents.delete(slug) }))

import { getSettings, getTeamBrain } from '@shared/lib/config/settings'
import { discardSetup, finishSetup, prepareSetup, saveChoices, type TeamBrainActor } from './team-brain-setup'

const actor: TeamBrainActor = { c: {} as Context, viewer: { userId: null, admin: true } }
const SOURCE = { type: 'local', config: { path: '/brain' } } as const
const DETAILS = { name: 'Team Brain', visibility: 'public' as const }
const stepOne = (setupId: string | null) => prepareSetup({ setupId, drive: { source: SOURCE, details: DETAILS } }, actor)
const finish = (setupId: string) => finishSetup({ setupId, setUpBy: null }, actor)
const stored = async () => (await getSettings()).teamBrain ?? null

let handle: TestDatabase

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  Object.assign(world, {
    agents: new Set(), drives: new Map(), driveCount: 0, installs: 0, installFails: false, policies: new Set(), tasks: [], granted: [], visible: [], hidden: [], auth: false, failInstructions: false, mountFails: false, duringInstructions: null,
    instructions: '- **Maintenance schedule:** `{{schedule}}`\n- **Brain location:** `{{brain_path}}`',
  })
})

afterEach(async () => {
  await handle.close()
})

describe('step 1', () => {
  it('claims before it provisions, and a second step 1 at the same time makes no second agent or drive', async () => {
    const [first, second] = await Promise.allSettled([stepOne(null), stepOne(null)])
    expect(world.installs).toBe(1)
    expect(world.drives.size).toBe(1)
    const won = [first, second].find((r) => r.status === 'fulfilled')
    const lost = [first, second].find((r) => r.status === 'rejected')
    expect(won?.status === 'fulfilled' && won.value.agentSlug).toBe('brain-1')
    expect(lost?.status === 'rejected' && lost.reason).toMatchObject({ status: 409, reason: 'stale', setup: { agentSlug: 'brain-1' } })
  })

  it('two step 1s on one set-up (a retry, a double click) install its agent once', async () => {
    world.installFails = true
    await expect(stepOne(null)).rejects.toThrow('clone failed')
    world.installFails = false
    const { setupId } = (await stored()) as { setupId: string }
    await Promise.all([stepOne(setupId), stepOne(setupId)])
    expect(world.installs).toBe(1)
  })

  it('refuses a window from before a Discard instead of starting a new set-up', async () => {
    const { setupId } = await stepOne(null)
    await discardSetup(setupId, actor)
    await expect(stepOne(setupId)).rejects.toMatchObject({ status: 404, reason: 'discarded' })
    expect(await stored()).toBeNull()
  })

  it('keeps the claim when the install fails, and the next step 1 installs into the same set-up', async () => {
    world.installFails = true
    await expect(stepOne(null)).rejects.toThrow('clone failed')
    const claimed = await stored()
    expect(claimed).toMatchObject({ status: 'setting-up', agentSlug: null })
    world.installFails = false
    const setup = await stepOne(claimed && 'status' in claimed ? claimed.setupId : null)
    expect(setup).toMatchObject({ agentSlug: 'brain-1', volumeId: 'drive-1' })
  })

  it('replaces the drive when the location changes, and keeps the agent', async () => {
    const { setupId } = await stepOne(null)
    const setup = await stepOne(setupId)
    expect(setup).toMatchObject({ agentSlug: 'brain-1', volumeId: 'drive-2' })
    expect([...world.drives.keys()]).toEqual(['drive-2'])
  })

  it('refuses a drive not every member can read, before making anything', async () => {
    await expect(prepareSetup({ setupId: null, drive: { source: SOURCE, details: { ...DETAILS, visibility: 'private' } } }, actor)).rejects.toMatchObject({ status: 400, reason: 'drive' })
    expect(await stored()).toBeNull()
  })
})

describe('choices', () => {
  it('saves as they change, keeps the furthest step, and never lands on a set-up started after a Discard', async () => {
    const { setupId, step } = await stepOne(null)
    expect(step).toBe('agents')
    await saveChoices(setupId, { step: 'schedule', schedule: 'weekly' })
    expect(await saveChoices(setupId, { step: 'agents', everyAgent: false })).toMatchObject({ step: 'schedule', schedule: 'weekly', everyAgent: false })
    await discardSetup(setupId, actor)
    const next = await stepOne(null)
    await expect(saveChoices(setupId, { schedule: 'hourly' })).rejects.toMatchObject({ reason: 'stale' })
    expect(await stored()).toMatchObject({ setupId: next.setupId, schedule: 'daily' })
  })
})

describe('the record', () => {
  it('reads as no Team Brain while a set-up runs, so members and readers wait for ready', async () => {
    await stepOne(null)
    expect(await getTeamBrain()).toBeNull()
  })
})

describe('Discard', () => {
  it('removes the agent, the drive and the record', async () => {
    const { setupId } = await stepOne(null)
    await discardSetup(setupId, actor)
    expect(world.agents.size).toBe(0)
    expect(world.drives.size).toBe(0)
    expect(await stored()).toBeNull()
  })
})

describe('Finish', () => {
  it('Finish and Discard at once: one runs whole, the other meets its result', async () => {
    const { setupId } = await stepOne(null)
    const [finished, discarded] = await Promise.allSettled([finish(setupId), discardSetup(setupId, actor)])
    expect(finished.status).toBe('fulfilled')
    expect(discarded.status === 'rejected' && discarded.reason).toMatchObject({ reason: 'ready' })
    expect(await stored()).toMatchObject({ agentSlug: 'brain-1', volumeId: 'drive-1' })
  })

  it('applies the saved choices, marks it ready, then gives members access; again on ready it only grants', async () => {
    world.visible = ['brain-1', 'sales', 'ops']
    const { setupId } = await stepOne(null)
    await saveChoices(setupId, { everyAgent: false, agents: { sales: true }, schedule: 'weekly' })
    await expect(finish(setupId)).resolves.toMatchObject({ agentSlug: 'brain-1', firstPrompt: 'hello', failedAgents: 0 })
    expect(await stored()).toEqual({ agentSlug: 'brain-1', volumeId: 'drive-1' })
    expect(world.drives.get('drive-1')).toMatchObject({ global: null })
    expect(world.drives.get('drive-1')!.agents).toEqual(new Set(['brain-1', 'sales']))
    expect(world.policies).toEqual(new Set(['brain-1 list null', 'sales invoke brain-1', 'brain-1 read sales']))
    expect(world.tasks).toEqual([{ id: 'task-1', name: 'Brain upkeep', scheduleExpression: '0 0 * * 1' }])
    expect(world.instructions).toContain('weekly, Mondays at midnight')
    expect(world.granted).toEqual(['brain-1'])
    await finish(setupId)
    expect(world.granted).toEqual(['brain-1', 'brain-1'])
    expect(world.tasks).toHaveLength(1)
  })

  it('lets Team Brain list agents always, and read them only with Every agent', async () => {
    const { setupId } = await stepOne(null)
    await saveChoices(setupId, { everyAgent: true })
    await finish(setupId)
    expect(world.policies).toEqual(new Set(['brain-1 list null', 'brain-1 read null']))
    expect(world.drives.get('drive-1')).toMatchObject({ global: 'read' })
  })

  it('a retry after a failed Finish and a changed choice sets the new schedule', async () => {
    world.visible = ['brain-1', 'sales']
    const { setupId } = await stepOne(null)
    await saveChoices(setupId, { everyAgent: false, agents: { sales: true }, schedule: 'daily' })
    world.failInstructions = true
    await expect(finish(setupId)).rejects.toThrow('disk full')
    expect(await stored()).toMatchObject({ status: 'setting-up' })

    world.failInstructions = false
    await saveChoices(setupId, { schedule: 'weekly' })
    await finish(setupId)
    expect(world.tasks).toEqual([{ id: 'task-1', name: 'Brain upkeep', scheduleExpression: '0 0 * * 1' }])
    expect(await stored()).toEqual({ agentSlug: 'brain-1', volumeId: 'drive-1' })
  })
  it('a choice saved while Finish runs leaves it setting up, and Finish again applies it', async () => {
    const { setupId } = await stepOne(null)
    world.duringInstructions = () => saveChoices(setupId, { schedule: 'hourly' })
    await expect(finish(setupId)).rejects.toMatchObject({ status: 409, reason: 'changed' })
    expect(world.granted).toEqual([])
    world.duringInstructions = null
    await finish(setupId)
    expect(world.tasks[0].scheduleExpression).toBe('0 * * * *')
  })

  it('refuses without an agent and drive, naming the cause', async () => {
    world.installFails = true
    await expect(stepOne(null)).rejects.toThrow('clone failed')
    const { setupId } = (await stored()) as { setupId: string }
    await expect(finish(setupId)).rejects.toMatchObject({ status: 409, reason: 'incomplete' })
  })
})
