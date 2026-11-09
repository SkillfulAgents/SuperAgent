/**
 * Team Brain set-up, on the server. Step 1 claims the workspace's one set-up
 * before anything exists, then makes the agent and the drive and saves each id
 * into it the moment it is made. Choices save as they change. Finish applies
 * them from the record and marks the Team Brain ready. Step 1, Finish and
 * Discard run under one lease, so two admins, a retry or a double click reuse
 * the one set-up instead of making a second.
 */
import { randomUUID } from 'crypto'
import type { Context } from 'hono'
import { agentCatalog } from '@shared/lib/agent-actor'
import { defineLease, type LeaseHolding } from '@shared/lib/app-state'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getSettings, updateSettings } from '@shared/lib/config/settings'
import { readyTeamBrain, TEAM_BRAIN_STEPS, type TeamBrainChoices, type TeamBrainSetup, type TeamBrainStep, type TeamBrainStored } from '@shared/lib/config/team-brain-schema'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { addAgentUsers } from '@shared/lib/services/agent-members-service'
import { accessibleAgents } from '@shared/lib/services/notification-service'
import { getAgent, updateAgent } from '@shared/lib/services/agent-service'
import { getDiscoverableAgents, hasOnboardingSkill, installAgentFromSkillset } from '@shared/lib/services/agent-template-service'
import { addMount, attachMount, getMounts } from '@shared/lib/services/mount-service'
import { createScheduledTask, listPendingScheduledTasks, updateScheduleExpression } from '@shared/lib/services/scheduled-task-service'
import { ensureSkillsetCached, toSkillsetRefFromConfig } from '@shared/lib/services/skillset-service'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { deleteVolumeDefinition, releaseVolume, updateVolumeDefinition, type VolumeViewer } from '@shared/lib/services/volume-service'
import { setPolicy } from '@shared/lib/services/x-agent-policy-service'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { SkillsetConfig } from '@shared/lib/types/skillset'
import { fillTeamBrainSetupBlock, TEAM_BRAIN_CRON } from '@shared/lib/team-brain/team-brain-setup-block'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { VolumeError } from '@shared/lib/volumes/volume-error'
import { afterMountChange } from './mount-change'
import { createOwnerAclOrRollback } from './owner-acl'
import { removeAgent } from './remove-agent'

const TEAM_BRAIN_TEMPLATE_PATH = 'agents/team-brain/'
const BRAIN_UPKEEP_NAME = 'Brain upkeep'
const BRAIN_UPKEEP_PROMPT = 'Run the maintain-brain skill (scheduled upkeep). Follow your system prompt. If no brain location is set up yet, end quietly without a message or a sync summary.'

const setupLease = defineLease({ name: 'claim:team-brain-setup', ttlMs: 30_000 })
/** Longer than the slowest holder: a Finish over many agents, or an install that clones the skillset cold. */
const LEASE_WAIT_MS = 10 * 60_000
/** Lease left before a create only the holder may make: an install or a drive. */
const CREATE_MARGIN_MS = 20_000

/** Why a set-up request was refused. The page tells each apart. */
export type TeamBrainSetupRefusal =
  | 'none' // no set-up and no Team Brain
  | 'ready' // the Team Brain is set up
  | 'stale' // another set-up than the one the request names
  | 'discarded' // the set-up the request names is gone
  | 'skillset' // the Gamut Public Skillset is missing
  | 'template' // its Team Brain template is not readable yet
  | 'drive' // a drive not every member can read
  | 'incomplete' // Finish with no agent or no drive yet
  | 'changed' // a choice saved while Finish ran

export class TeamBrainSetupError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly reason: TeamBrainSetupRefusal,
    message: string,
    readonly setup: TeamBrainSetup | null = null,
  ) {
    super(message)
    this.name = 'TeamBrainSetupError'
  }
}

/** Who acts: the admin, and the context the agent routes create an owner from. */
export interface TeamBrainActor {
  readonly c: Context
  readonly viewer: VolumeViewer
}

async function underLease<T>(work: (holding: LeaseHolding) => Promise<T>): Promise<T> {
  const turn = await setupLease.acquireWhenFree(setupLease.key('workspace'), { timeoutMs: LEASE_WAIT_MS })
  if (!turn.acquired) return turn.result
  return setupLease.hold(turn.lease, work)
}

function refuseOther(stored: TeamBrainStored | null | undefined, setupId: string | null): TeamBrainSetup {
  if (readyTeamBrain(stored)) throw new TeamBrainSetupError(409, 'ready', 'Team Brain is already set up')
  if (!stored) {
    if (setupId) throw new TeamBrainSetupError(404, 'discarded', 'Team Brain set-up was discarded')
    throw new TeamBrainSetupError(404, 'none', 'No Team Brain set-up')
  }
  if (!('status' in stored)) throw new TeamBrainSetupError(409, 'ready', 'Team Brain is already set up')
  if (stored.setupId !== setupId) throw new TeamBrainSetupError(409, 'stale', 'Another Team Brain set-up is in progress', stored)
  return stored
}

/** Write `change` onto the set-up `setupId` names; refused when the settings moved on to another or ended. */
async function saveSetup(setupId: string, change: (setup: TeamBrainSetup) => TeamBrainSetup): Promise<TeamBrainSetup> {
  const { after } = await updateSettings((draft, before) => {
    draft.teamBrain = change(refuseOther(before.teamBrain, setupId))
  })
  return refuseOther(after.teamBrain, setupId)
}

export async function readSetupView(): Promise<{ setup: TeamBrainSetup }> {
  const stored = (await getSettings()).teamBrain
  if (!stored || !('status' in stored)) throw new TeamBrainSetupError(404, 'none', 'No Team Brain set-up')
  return { setup: stored }
}

export interface PrepareInput {
  /** The set-up the page holds; null before it has one. */
  readonly setupId: string | null
  /** The drive chosen on step 1. */
  readonly drive: { source: VolumeSource; details: { name: string; visibility: 'public' | 'private' } }
}

/**
 * Step 1: claim the set-up, then make the agent and the drive into it, saving
 * each id as it is made. Again on the same set-up (a retry, a new location) it
 * reuses the agent and replaces the drive.
 */
export async function prepareSetup({ setupId, drive }: PrepareInput, actor: TeamBrainActor): Promise<TeamBrainSetup> {
  if (drive.details.visibility !== 'public') {
    throw new TeamBrainSetupError(400, 'drive', 'Team Brain needs a drive everyone in the workspace can add')
  }
  return underLease(async (holding) => {
    const skillset = (await getSettings()).skillsets?.find((s) => s.id === DEFAULT_PUBLIC_SKILLSET.id)
    if (!skillset) throw new TeamBrainSetupError(409, 'skillset', 'Team Brain needs the Gamut Public Skillset')
    let setup = await claim(setupId)
    let { agentSlug } = setup
    if (!agentSlug) {
      const made = await installTeamBrainAgent(skillset, actor, holding)
      setup = await saveSetup(setup.setupId, (s) => ({ ...s, agentSlug: made }))
      agentSlug = made
    }
    if (setup.volumeId) await deleteDrive(setup.volumeId, actor.viewer)
    await holding.confirm({ minRemainingMs: CREATE_MARGIN_MS })
    const mount = await addMount(agentSlug, drive.source.type, drive.source.config, actor.viewer, drive.details)
    // Saving the drive is step 1 done: Resume opens past it.
    setup = await saveSetup(setup.setupId, (s) => ({ ...s, volumeId: mount.volumeId, location: drive.source.type, step: furthest(s.step, 'agents') }))
    await afterMountChange(agentSlug)
    return setup
  })
}

async function claim(setupId: string | null): Promise<TeamBrainSetup> {
  const fresh: TeamBrainSetup = {
    status: 'setting-up',
    setupId: randomUUID(),
    agentSlug: null,
    volumeId: null,
    location: null,
    step: 'location',
    schedule: 'daily',
    everyAgent: true,
    agents: {},
  }
  // Only a request that holds no set-up may claim; any other answers with what is there.
  const { before, written } = await updateSettings((draft, current) => {
    if (current.teamBrain || setupId) return false
    draft.teamBrain = fresh
  })
  return written ? fresh : refuseOther(before.teamBrain, setupId)
}

async function installTeamBrainAgent(skillset: SkillsetConfig, actor: TeamBrainActor, holding: LeaseHolding): Promise<string> {
  // A workspace whose skillset was never opened has no copy to read the template from yet.
  await ensureSkillsetCached(toSkillsetRefFromConfig(skillset))
  const template = (await getDiscoverableAgents([skillset])).find((t) => t.path === TEAM_BRAIN_TEMPLATE_PATH)
  if (!template) throw new TeamBrainSetupError(503, 'template', 'The Team Brain template is not available yet. Try again in a moment.')
  // A cold copy can outlast the lease: confirm it right before the create only the holder may make.
  await holding.confirm({ minRemainingMs: CREATE_MARGIN_MS })
  const agent = await installAgentFromSkillset(toSkillsetRefFromConfig(skillset), template.path, template.name, template.version)
  await createOwnerAclOrRollback(actor.c, agent.slug)
  return agent.slug
}

/** A drive the set-up made: off every agent, then gone. One already gone is fine. */
async function deleteDrive(volumeId: string, viewer: VolumeViewer): Promise<void> {
  try {
    for (const agent of await releaseVolume(volumeId, '')) await afterMountChange(agent)
    await deleteVolumeDefinition(volumeId, viewer)
  } catch (error) {
    if (error instanceof VolumeError && error.status === 404) return
    throw error
  }
}

const furthest = (a: TeamBrainStep, b: TeamBrainStep): TeamBrainStep => (TEAM_BRAIN_STEPS.indexOf(b) > TEAM_BRAIN_STEPS.indexOf(a) ? b : a)

/** Save a change of step or choices. The step only moves forward, so a second window cannot move it back. */
export async function saveChoices(setupId: string, changes: Partial<TeamBrainChoices>): Promise<TeamBrainSetup> {
  return saveSetup(setupId, (s) => ({ ...s, ...changes, agents: { ...s.agents, ...changes.agents }, step: changes.step ? furthest(s.step, changes.step) : s.step }))
}

/** Discard: the agent, then its drive, then the record last, so a removal that fails can run again. */
export async function discardSetup(setupId: string, actor: TeamBrainActor): Promise<void> {
  await underLease(async () => {
    const stored = (await getSettings()).teamBrain
    if (!stored) return
    const setup = refuseOther(stored, setupId)
    if (setup.agentSlug) await removeAgent(setup.agentSlug)
    if (setup.volumeId) await deleteDrive(setup.volumeId, actor.viewer)
    await updateSettings((draft, before) => {
      if (before.teamBrain && 'status' in before.teamBrain && before.teamBrain.setupId === setupId) delete draft.teamBrain
      else return false
    })
  })
}

export interface FinishInput {
  readonly setupId: string
  /** Who set it up and the account types connected, for the agent's opening research. */
  readonly setUpBy: { name: string; email: string } | null
  readonly accounts?: { toolkitSlug: string; status: string }[]
}

export interface FinishResult {
  readonly agentSlug: string
  readonly firstPrompt?: string
  /** Agents that could not be given Team Brain; the admin adds the drive from each one's Drives. */
  readonly failedAgents: number
}

/**
 * Finish: apply the saved choices, mark the Team Brain ready, then give it to
 * every member. Each step is safe to run again, so a retry ends where the
 * choices say. On a ready Team Brain it gives members access again.
 */
export async function finishSetup(input: FinishInput, actor: TeamBrainActor): Promise<FinishResult> {
  return underLease(async () => {
    const stored = (await getSettings()).teamBrain
    const ready = readyTeamBrain(stored)
    if (ready) {
      await addAgentUsers(ready.agentSlug)
      return { agentSlug: ready.agentSlug, firstPrompt: (await hasOnboardingSkill(ready.agentSlug)).firstPrompt, failedAgents: 0 }
    }
    const setup = refuseOther(stored, input.setupId)
    const { agentSlug, volumeId } = setup
    const mount = agentSlug && volumeId ? (await getMounts(agentSlug)).find((m) => m.volumeId === volumeId) : undefined
    if (!agentSlug || !volumeId || !mount) throw new TeamBrainSetupError(409, 'incomplete', 'Set up where Team Brain lives first', setup)

    // Team Brain's own read-write attachment wins over the global read-only one.
    if (setup.everyAgent) await updateVolumeDefinition(volumeId, { global: 'read' }, actor.viewer)
    await scheduleUpkeep(agentSlug, TEAM_BRAIN_CRON[setup.schedule], actor)
    await setPolicy(agentSlug, 'list', null, 'allow')
    if (setup.everyAgent) await setPolicy(agentSlug, 'read', null, 'allow')
    const failedAgents = await giveChosenAgents(setup, agentSlug, volumeId, actor)
    const agent = await getAgent(agentSlug)
    const instructions = fillTeamBrainSetupBlock(agent?.instructions ?? '', {
      agentSlug, brainPath: mountPathOf(mount.name), schedule: setup.schedule, setUpBy: input.setUpBy, accounts: input.accounts,
    })
    await updateAgent(agentSlug, { instructions })

    // Ready only while the set-up is still the one Finish read: a choice saved meanwhile sends the admin round again.
    const applied = JSON.stringify(setup)
    const { written } = await updateSettings((draft, before) => {
      if (JSON.stringify(before.teamBrain) !== applied) return false
      draft.teamBrain = { agentSlug, volumeId }
    })
    if (!written) {
      throw new TeamBrainSetupError(409, 'changed', 'Team Brain set-up changed while it was finishing. Start chat again.')
    }
    await addAgentUsers(agentSlug)
    return { agentSlug, firstPrompt: (await hasOnboardingSkill(agentSlug)).firstPrompt, failedAgents }
  })
}

async function scheduleUpkeep(agentSlug: string, scheduleExpression: string, actor: TeamBrainActor): Promise<void> {
  const existing = (await listPendingScheduledTasks(agentSlug)).find((task) => task.name === BRAIN_UPKEEP_NAME)
  if (existing) {
    if (existing.scheduleExpression !== scheduleExpression) await updateScheduleExpression(existing.id, scheduleExpression)
    return
  }
  const taskId = await createScheduledTask({
    agentSlug,
    scheduleType: 'cron',
    scheduleExpression,
    prompt: BRAIN_UPKEEP_PROMPT,
    name: BRAIN_UPKEEP_NAME,
    createdByUserId: getCurrentUserId(actor.c),
    timezone: await resolveTimezoneForAgent(agentSlug),
  })
  globalFeed.publish({ type: 'scheduled_task_created', taskId, agentSlug })
}

/**
 * Give each agent the window offered and the choices turned on the drive
 * (unless every agent has it) and messaging both ways. A failed give is
 * counted for a warning; the admin adds the drive from that agent's Drives.
 */
async function giveChosenAgents(setup: TeamBrainSetup, brainSlug: string, volumeId: string, actor: TeamBrainActor): Promise<number> {
  let failed = 0
  for (const slug of await visibleAgentSlugs(actor)) {
    if (slug === brainSlug || !(setup.everyAgent || setup.agents[slug])) continue
    try {
      if (!setup.everyAgent) {
        await attachMount(slug, volumeId, actor.viewer, { readOnly: true })
        await afterMountChange(slug)
      }
      await setPolicy(slug, 'invoke', brainSlug, 'allow')
      await setPolicy(brainSlug, 'read', slug, 'allow')
    } catch (error) {
      console.error(`Could not give Team Brain to agent ${slug}:`, error)
      failed++
    }
  }
  return failed
}

/** The agents the admin's lists show, the ones the set-up window offers. */
async function visibleAgentSlugs(actor: TeamBrainActor): Promise<string[]> {
  if (!isAuthMode()) return agentCatalog.list()
  return (await accessibleAgents(getCurrentUserId(actor.c)).all()).map((row) => row.agentSlug)
}
