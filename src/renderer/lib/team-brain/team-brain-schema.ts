import { z } from 'zod'
import { VOLUME_TYPES } from '@shared/lib/types/mount'

/**
 * Team Brain: one shared, agent-maintained wiki for the whole workspace, kept
 * on a drive its agent writes and the agents given access read. These are the
 * set-up modal's choices.
 */

export const TEAM_BRAIN_SOURCE_IDS = [
  'slack',
  'notion',
  'googledrive',
  'github',
  'linear',
  'confluence',
  'gmail',
  'dropbox',
  'jira',
  'outlook',
  'teams',
] as const
export type TeamBrainSourceId = (typeof TEAM_BRAIN_SOURCE_IDS)[number]

/** Where the Team Brain's files can live: any drive type the app supports. */
export const TEAM_BRAIN_LOCATION_IDS = VOLUME_TYPES
export type TeamBrainLocationId = (typeof TEAM_BRAIN_LOCATION_IDS)[number]

export const TEAM_BRAIN_SCHEDULES = ['hourly', 'daily', 'weekly'] as const
export type TeamBrainSchedule = (typeof TEAM_BRAIN_SCHEDULES)[number]

/**
 * The set-up modal's steps, in order: the settings a form asks best, then the
 * hand-over to a chat with Team Brain for the team's context.
 */
export const TEAM_BRAIN_STEPS = ['location', 'agents', 'schedule', 'intake'] as const

/** Every step set-up can take, in order: on the desktop it first asks how (`how`); the rail keeps them all and folds away the ones not taken. */
export const ALL_TEAM_BRAIN_STEPS = ['how', ...TEAM_BRAIN_STEPS] as const
export type TeamBrainStep = (typeof ALL_TEAM_BRAIN_STEPS)[number]

/** How the desktop gets its Team Brain: set up in the cloud workspace, a folder managed elsewhere (read-only), or set up here. */
export const TEAM_BRAIN_PATHS = ['cloud', 'team', 'here'] as const
export type TeamBrainPath = (typeof TEAM_BRAIN_PATHS)[number]

/**
 * The steps set-up takes. On the desktop, how first, then the chosen path's: a folder managed elsewhere needs only
 * where it lives and which agents read it, since it is managed elsewhere, so there is no schedule and no chat to
 * build it. Elsewhere, setting one up here.
 */
export function teamBrainSteps(desktop: boolean, path: TeamBrainPath | null): readonly TeamBrainStep[] {
  if (!desktop) return TEAM_BRAIN_STEPS
  // The cloud's set-up happens in the cloud workspace, after the switch.
  if (!path || path === 'cloud') return ['how']
  return path === 'team' ? ['how', 'location', 'agents'] : ALL_TEAM_BRAIN_STEPS
}

/** The Team Brain agent and drive created when step 01 is done, before Start chat. */
export const teamBrainPreparedSchema = z.object({
  agentSlug: z.string(),
  volumeId: z.string(),
  /** Where the drive is mounted inside the agent's container. */
  brainPath: z.string(),
  firstPrompt: z.string().optional(),
  /** Reads a folder managed elsewhere: its own drive is read-only. */
  readOnly: z.boolean(),
})
export type TeamBrainPrepared = z.infer<typeof teamBrainPreparedSchema>

/** `off` (the page before anyone opts in) → `onboarding` (the set-up modal) → `launching` (after Start chat). */
export const teamBrainStateSchema = z.object({
  status: z.enum(['off', 'onboarding', 'launching']),
  step: z.enum(ALL_TEAM_BRAIN_STEPS).default('location'),
  /** On the desktop, the path chosen at `how`; null until Next there. */
  path: z.enum(TEAM_BRAIN_PATHS).nullable().default(null),
  /** Where the files live. Chosen first; null until chosen. */
  location: z.enum(TEAM_BRAIN_LOCATION_IDS).nullable().default(null),
  schedule: z.enum(TEAM_BRAIN_SCHEDULES).default('daily'),
  prepared: teamBrainPreparedSchema.nullable().default(null),
  /** The agent just installed, before its drive makes it `prepared`. */
  installing: z.string().nullable().default(null),
  /** Which agents use Team Brain (read the drive, message its agent), by slug. An agent not listed does. */
  agents: z.record(z.string(), z.boolean()).default({}),
  /** Every agent, including ones made later: the drive goes global, read-only. */
  everyAgent: z.boolean().default(true),
})

export type TeamBrainState = z.infer<typeof teamBrainStateSchema>

export const TEAM_BRAIN_INITIAL_STATE: TeamBrainState = teamBrainStateSchema.parse({ status: 'off' })
