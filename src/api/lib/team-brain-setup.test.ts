import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

// The agents and drives the page makes through the app's own routes; the claim only names them.
const world = vi.hoisted(() => ({
  agents: new Set<string>(),
  /** Drive id → the agents it is attached to, and whether every member can add it. */
  drives: new Map<string, { agents: Set<string>; public: boolean }>(),
  granted: [] as string[],
}))
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: async (slug: string) => world.agents.has(slug) }))
vi.mock('@shared/lib/services/agent-template-service', () => ({ hasOnboardingSkill: async () => ({ hasOnboarding: true, firstPrompt: 'hello' }) }))
vi.mock('@shared/lib/services/mount-service', () => ({
  getMounts: async (slug: string) => [...world.drives].filter(([, d]) => d.agents.has(slug)).map(([volumeId]) => ({ volumeId })),
}))
vi.mock('@shared/lib/services/volume-service', () => ({ isPublicVolume: async (id: string) => world.drives.get(id)?.public ?? false }))
vi.mock('@shared/lib/services/agent-members-service', () => ({ addAgentUsers: async (slug: string) => { world.granted.push(slug) } }))

import { getSettings, getTeamBrain } from '@shared/lib/config/settings'
import { claimSetup, dropSetup, markReady, readSetupView, saveSetup } from './team-brain-setup'

const stored = async () => (await getSettings()).teamBrain ?? null
/** The page's step 1: an agent and a drive made through the routes, each recorded once made. */
async function stepOne() {
  const { setup } = await claimSetup()
  world.agents.add('brain')
  await saveSetup(setup.setupId, { agent: { slug: 'brain', replaces: null } })
  world.drives.set('drive-1', { agents: new Set(['brain']), public: true })
  return saveSetup(setup.setupId, { drive: { volumeId: 'drive-1', location: 'googledrive', replaces: null }, step: 'agents' })
}

let handle: TestDatabase

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  Object.assign(world, { agents: new Set(), drives: new Map(), granted: [] })
})

afterEach(async () => {
  await handle.close()
})

describe('claim', () => {
  it('claims one empty set-up per workspace: a second claim at the same time is refused, and reads the first', async () => {
    const [first, second] = await Promise.allSettled([claimSetup(), claimSetup()])
    const won = [first, second].find((r) => r.status === 'fulfilled')
    const lost = [first, second].find((r) => r.status === 'rejected')
    expect(won?.status === 'fulfilled' && won.value).toMatchObject({ setup: { agentSlug: null, volumeId: null, step: 'location' }, agent: false, drive: false })
    expect(lost?.status === 'rejected' && lost.reason).toMatchObject({ status: 409, reason: 'stale' })
    expect((await readSetupView()).setup.setupId).toBe(won?.status === 'fulfilled' && won.value.setup.setupId)
  })

  it('refuses a claim once Team Brain is set up', async () => {
    const { setup } = await stepOne()
    await markReady(setup.setupId)
    await expect(claimSetup()).rejects.toMatchObject({ status: 409, reason: 'ready' })
  })

  it('reads as no Team Brain while a set-up runs, so members and readers wait for ready', async () => {
    await stepOne()
    expect(await getTeamBrain()).toBeNull()
  })
})

describe('resume', () => {
  it('says step 1 is done only while its agent holds its drive', async () => {
    const { setup } = await claimSetup()
    expect(await readSetupView()).toMatchObject({ agent: false, drive: false })
    world.agents.add('brain')
    await saveSetup(setup.setupId, { agent: { slug: 'brain', replaces: null } })
    expect(await readSetupView()).toMatchObject({ agent: true, drive: false })
    world.drives.set('drive-1', { agents: new Set(['brain']), public: true })
    await saveSetup(setup.setupId, { drive: { volumeId: 'drive-1', location: 'googledrive', replaces: null } })
    expect(await readSetupView()).toMatchObject({ agent: true, drive: true })
  })

  it('names an agent or drive removed by hand as gone, so the page sets them up again', async () => {
    await stepOne()
    world.drives.get('drive-1')!.agents.clear()
    expect(await readSetupView()).toMatchObject({ setup: { volumeId: 'drive-1' }, agent: true, drive: false })
    world.agents.clear()
    expect(await readSetupView()).toMatchObject({ setup: { agentSlug: 'brain' }, agent: false, drive: false })
  })

  it('answers 404 with no set-up, set up or not', async () => {
    await expect(readSetupView()).rejects.toMatchObject({ status: 404, reason: 'none' })
    const { setup } = await stepOne()
    await markReady(setup.setupId)
    await expect(readSetupView()).rejects.toMatchObject({ status: 404, reason: 'none' })
  })
})

describe('save', () => {
  it('records what the page made only over what it saw, so two windows never both set one', async () => {
    const { setup } = await claimSetup()
    await saveSetup(setup.setupId, { agent: { slug: 'brain-a', replaces: null } })
    await expect(saveSetup(setup.setupId, { agent: { slug: 'brain-b', replaces: null } })).rejects.toMatchObject({ status: 409, reason: 'changed' })
    // A page that saw brain-a gone replaces it.
    expect((await saveSetup(setup.setupId, { agent: { slug: 'brain-b', replaces: 'brain-a' } })).setup.agentSlug).toBe('brain-b')
  })

  it('releases a drive before the page removes it, and refuses a drive not every member can read', async () => {
    const { setup } = await stepOne()
    world.drives.set('private', { agents: new Set(['brain']), public: false })
    await expect(saveSetup(setup.setupId, { drive: { volumeId: 'private', location: 'local', replaces: 'drive-1' } })).rejects.toMatchObject({ status: 400, reason: 'drive' })
    const released = await saveSetup(setup.setupId, { drive: { volumeId: null, location: null, replaces: 'drive-1' } })
    expect(released).toMatchObject({ setup: { volumeId: null, location: null, agentSlug: 'brain' }, drive: false })
  })

  it('keeps the furthest step and the choices, and never lands on a set-up started after a Discard', async () => {
    const { setup } = await stepOne()
    await saveSetup(setup.setupId, { step: 'schedule', schedule: 'weekly', agents: { sales: true } })
    expect((await saveSetup(setup.setupId, { step: 'agents', everyAgent: false, agents: { ops: false } })).setup)
      .toMatchObject({ step: 'schedule', schedule: 'weekly', everyAgent: false, agents: { sales: true, ops: false } })
    await dropSetup(setup.setupId)
    await expect(saveSetup(setup.setupId, { schedule: 'hourly' })).rejects.toMatchObject({ status: 404, reason: 'discarded' })
    const next = await claimSetup()
    await expect(saveSetup(setup.setupId, { schedule: 'hourly' })).rejects.toMatchObject({ status: 409, reason: 'stale' })
    expect(await stored()).toMatchObject({ setupId: next.setup.setupId, schedule: 'daily' })
  })
})

describe('Discard', () => {
  it('drops the claim first and answers what it named, for the page to remove', async () => {
    const { setup } = await stepOne()
    await expect(dropSetup(setup.setupId)).resolves.toEqual({ agentSlug: 'brain', volumeId: 'drive-1' })
    expect(await stored()).toBeNull()
  })

  it('never answers a finished Team Brain, so a page behind can never remove it', async () => {
    const { setup } = await stepOne()
    await markReady(setup.setupId)
    await expect(dropSetup(setup.setupId)).rejects.toMatchObject({ status: 409, reason: 'ready' })
    expect(await stored()).toEqual({ agentSlug: 'brain', volumeId: 'drive-1' })
  })
})

describe('ready', () => {
  it('marks the set-up ready, then gives every member its agent; again it only gives access again', async () => {
    const { setup } = await stepOne()
    await expect(markReady(setup.setupId)).resolves.toEqual({ agentSlug: 'brain', volumeId: 'drive-1', firstPrompt: 'hello' })
    expect(await stored()).toEqual({ agentSlug: 'brain', volumeId: 'drive-1' })
    expect(await getTeamBrain()).toEqual({ agentSlug: 'brain', volumeId: 'drive-1' })
    expect(world.granted).toEqual(['brain'])
    // A retry whose answer was lost.
    await expect(markReady(setup.setupId)).resolves.toMatchObject({ agentSlug: 'brain' })
    expect(world.granted).toEqual(['brain', 'brain'])
  })

  it('refuses until the agent holds the drive, and gives no one access', async () => {
    const { setup } = await claimSetup()
    await expect(markReady(setup.setupId)).rejects.toMatchObject({ status: 409, reason: 'incomplete' })
    world.agents.add('brain')
    await saveSetup(setup.setupId, { agent: { slug: 'brain', replaces: null } })
    world.drives.set('drive-1', { agents: new Set(), public: true })
    await saveSetup(setup.setupId, { drive: { volumeId: 'drive-1', location: 'googledrive', replaces: null } })
    await expect(markReady(setup.setupId)).rejects.toMatchObject({ status: 409, reason: 'incomplete' })
    expect(world.granted).toEqual([])
    expect(await stored()).toMatchObject({ status: 'setting-up' })
  })

  it('refuses a drive that stopped being one every member can add', async () => {
    const { setup } = await stepOne()
    world.drives.get('drive-1')!.public = false
    await expect(markReady(setup.setupId)).rejects.toMatchObject({ status: 409, reason: 'incomplete' })
  })
})
