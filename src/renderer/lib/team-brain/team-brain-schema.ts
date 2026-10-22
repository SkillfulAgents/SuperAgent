import { z } from 'zod'
import { VOLUME_TYPES } from '@shared/lib/types/mount'

/**
 * Team Brain (prototype): one shared, agent-maintained wiki for the whole
 * workspace, mounted as a drive on every agent. This first slice is the page
 * before anyone opts in and the set-up modal. What the modal settles is held
 * in memory for now; the set-up chat that follows it is a later change.
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

/**
 * Where the Team Brain's files can live. Every drive type the app supports
 * today (Google Drive, Dropbox, S3, a local folder) plus three it would add:
 * hosted by Gamut, a GitHub repository, and an Obsidian vault.
 */
export const TEAM_BRAIN_LOCATION_IDS = ['gamut', 'github', 'obsidian', ...VOLUME_TYPES] as const
export type TeamBrainLocationId = (typeof TEAM_BRAIN_LOCATION_IDS)[number]

export const TEAM_BRAIN_SCHEDULES = ['hourly', 'daily', 'weekly'] as const
export type TeamBrainSchedule = (typeof TEAM_BRAIN_SCHEDULES)[number]

/**
 * The set-up modal's steps, in order: the settings a form asks best, then the
 * hand-over to a chat with Team Brain for the team's context.
 */
export const TEAM_BRAIN_STEPS = ['location', 'agents', 'schedule', 'intake'] as const
export type TeamBrainStep = (typeof TEAM_BRAIN_STEPS)[number]

/** The Team Brain agent and drive created when step 01 is done, before Start chat. */
export const teamBrainPreparedSchema = z.object({
  agentSlug: z.string(),
  volumeId: z.string(),
  /** Where the drive is mounted inside the agent's container. */
  brainPath: z.string(),
  firstPrompt: z.string().optional(),
  /** Whether everyone can add the drive. Only such a drive can go to every agent. */
  isPublic: z.boolean(),
})
export type TeamBrainPrepared = z.infer<typeof teamBrainPreparedSchema>

/** `off` (the page before anyone opts in) → `onboarding` (the set-up modal) → `launching` (after Start chat). */
export const teamBrainStateSchema = z.object({
  status: z.enum(['off', 'onboarding', 'launching']),
  step: z.enum(TEAM_BRAIN_STEPS).default('location'),
  /** Where the files live. Chosen first; null until chosen. */
  location: z.enum(TEAM_BRAIN_LOCATION_IDS).nullable().default(null),
  schedule: z.enum(TEAM_BRAIN_SCHEDULES).default('daily'),
  prepared: teamBrainPreparedSchema.nullable().default(null),
  /** The agent just installed, before its drive makes it `prepared`. */
  installing: z.string().nullable().default(null),
  /** Which agents use Team Brain (read the drive, message its agent), by slug. An agent not listed does. */
  agents: z.record(z.string(), z.boolean()).default({}),
  /** Every agent, including ones made later: the drive goes global, read-only. */
  everyAgent: z.boolean().default(false),
})

export type TeamBrainState = z.infer<typeof teamBrainStateSchema>

export const TEAM_BRAIN_INITIAL_STATE: TeamBrainState = teamBrainStateSchema.parse({ status: 'off' })
