/**
 * Team Brain set-up's claim. The page runs the set-up through the app's own
 * routes (install the agent, make the drive, permissions, upkeep); the server
 * holds only the claim, so a reload, another computer or another admin resumes
 * it: which set-up is the workspace's, the agent and drive it made, and the
 * choices so far. Ready turns the claim into the Team Brain.
 *
 * The page records what it made right after making it, and releases what it
 * removes right before removing it. Each change names what the page saw, so a
 * page behind another window's change is refused instead of overwriting it.
 */
import { randomUUID } from 'crypto'
import { getSettings, updateSettings } from '@shared/lib/config/settings'
import {
  readyTeamBrain,
  type TeamBrainChoices,
  type TeamBrainLocationId,
  type TeamBrainRecord,
  type TeamBrainSetup,
  type TeamBrainSetupView,
  type TeamBrainStep,
  type TeamBrainStored,
  TEAM_BRAIN_STEPS,
} from '@shared/lib/config/team-brain-schema'
import { addAgentUsers } from '@shared/lib/services/agent-members-service'
import { agentExists } from '@shared/lib/services/agent-service'
import { hasOnboardingSkill } from '@shared/lib/services/agent-template-service'
import { getMounts } from '@shared/lib/services/mount-service'
import { isPublicVolume } from '@shared/lib/services/volume-service'

/** Why a set-up request was refused. The page tells each apart. */
export type TeamBrainSetupRefusal =
  | 'none' // no set-up and no Team Brain
  | 'ready' // the Team Brain is set up
  | 'stale' // another set-up than the one the request names
  | 'discarded' // the set-up the request names is gone
  | 'changed' // its agent or drive changed since the page read it
  | 'drive' // a drive not every member can read
  | 'incomplete' // ready without its agent holding its drive

export class TeamBrainSetupError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly reason: TeamBrainSetupRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'TeamBrainSetupError'
  }
}

function refuseOther(stored: TeamBrainStored | null | undefined, setupId: string): TeamBrainSetup {
  if (readyTeamBrain(stored)) throw new TeamBrainSetupError(409, 'ready', 'Team Brain is already set up')
  if (!stored || !('status' in stored)) throw new TeamBrainSetupError(404, 'discarded', 'Team Brain set-up was discarded')
  if (stored.setupId !== setupId) throw new TeamBrainSetupError(409, 'stale', 'Another Team Brain set-up is in progress')
  return stored
}

async function viewOf(setup: TeamBrainSetup): Promise<TeamBrainSetupView> {
  const agent = !!setup.agentSlug && await agentExists(setup.agentSlug)
  const drive = agent && !!setup.volumeId && (await getMounts(setup.agentSlug!)).some((mount) => mount.volumeId === setup.volumeId)
  return { setup, agent, drive }
}

/** The set-up in progress; 404 when there is none, set up or not. */
export async function readSetupView(): Promise<TeamBrainSetupView> {
  const stored = (await getSettings()).teamBrain
  if (!stored || !('status' in stored)) throw new TeamBrainSetupError(404, 'none', 'No Team Brain set-up')
  return viewOf(stored)
}

/** Claim the workspace's one set-up, empty. Refused when there is one: the page reads it and continues it. */
export async function claimSetup(): Promise<TeamBrainSetupView> {
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
  const { before, written } = await updateSettings((draft, current) => {
    if (current.teamBrain) return false
    draft.teamBrain = fresh
  })
  if (written) return { setup: fresh, agent: false, drive: false }
  if (readyTeamBrain(before.teamBrain)) throw new TeamBrainSetupError(409, 'ready', 'Team Brain is already set up')
  throw new TeamBrainSetupError(409, 'stale', 'Another Team Brain set-up is in progress')
}

/** Set or release the set-up's agent or drive: `replaces` is what the page saw there. */
export interface SetupChanges extends Partial<TeamBrainChoices> {
  readonly agent?: { slug: string | null; replaces: string | null }
  readonly drive?: { volumeId: string | null; location: TeamBrainLocationId | null; replaces: string | null }
}

const furthest = (a: TeamBrainStep, b: TeamBrainStep): TeamBrainStep => (TEAM_BRAIN_STEPS.indexOf(b) > TEAM_BRAIN_STEPS.indexOf(a) ? b : a)

/** Save what the page made or chose. The step only moves forward, so a second window cannot move it back. */
export async function saveSetup(setupId: string, { agent, drive, ...choices }: SetupChanges): Promise<TeamBrainSetupView> {
  // Every member is given the Team Brain, so every member must be able to read its drive.
  if (drive?.volumeId && !(await isPublicVolume(drive.volumeId))) {
    throw new TeamBrainSetupError(400, 'drive', 'Team Brain needs a drive everyone in the workspace can add')
  }
  const { after } = await updateSettings((draft, before) => {
    const setup = refuseOther(before.teamBrain, setupId)
    if ((agent && setup.agentSlug !== agent.replaces) || (drive && setup.volumeId !== drive.replaces)) {
      throw new TeamBrainSetupError(409, 'changed', 'Team Brain set-up changed in another window')
    }
    draft.teamBrain = {
      ...setup,
      ...choices,
      agents: { ...setup.agents, ...choices.agents },
      step: choices.step ? furthest(setup.step, choices.step) : setup.step,
      ...(agent ? { agentSlug: agent.slug } : {}),
      ...(drive ? { volumeId: drive.volumeId, location: drive.location } : {}),
    }
  })
  return viewOf(refuseOther(after.teamBrain, setupId))
}

/**
 * Discard: drop the claim and answer what it named, for the page to remove. Dropped first, so a page reading an
 * older set-up can never remove a Team Brain finished meanwhile.
 */
export async function dropSetup(setupId: string): Promise<Pick<TeamBrainSetup, 'agentSlug' | 'volumeId'>> {
  const { before } = await updateSettings((draft, current) => {
    refuseOther(current.teamBrain, setupId)
    delete draft.teamBrain
  })
  const { agentSlug, volumeId } = refuseOther(before.teamBrain, setupId)
  return { agentSlug, volumeId }
}

export interface ReadyResult extends TeamBrainRecord {
  readonly firstPrompt?: string
}

/**
 * Mark the set-up ready once its agent holds its drive, then give every member the agent. On a ready Team Brain it
 * gives members access again, so a retry whose answer was lost ends the same.
 */
export async function markReady(setupId: string): Promise<ReadyResult> {
  const stored = (await getSettings()).teamBrain
  let record = readyTeamBrain(stored)
  if (!record) {
    const { setup, drive } = await viewOf(refuseOther(stored, setupId))
    if (!drive || !(await isPublicVolume(setup.volumeId!))) {
      throw new TeamBrainSetupError(409, 'incomplete', 'Set up where Team Brain lives first')
    }
    const next = { agentSlug: setup.agentSlug!, volumeId: setup.volumeId! }
    await updateSettings((draft, before) => {
      const current = refuseOther(before.teamBrain, setupId)
      if (current.agentSlug !== next.agentSlug || current.volumeId !== next.volumeId) {
        throw new TeamBrainSetupError(409, 'changed', 'Team Brain set-up changed in another window')
      }
      draft.teamBrain = next
    })
    record = next
  }
  // The Team Brain is the workspace's: every member is a user of its agent, and members who join later get it when
  // their account is made. Giving it twice adds no one twice.
  await addAgentUsers(record.agentSlug)
  return { ...record, firstPrompt: (await hasOnboardingSkill(record.agentSlug)).firstPrompt }
}
