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

/** What an agent may do with Team Brain: read its context, write what it learns, or both. */
export const TEAM_BRAIN_ACCESS = ['read', 'write', 'both'] as const
export type TeamBrainAccess = (typeof TEAM_BRAIN_ACCESS)[number]
export type TeamBrainAgentAccess = TeamBrainAccess | 'none'

/** `off` (the page before anyone opts in) → `onboarding` (the set-up modal). */
export const teamBrainStateSchema = z.object({
  status: z.enum(['off', 'onboarding']),
  step: z.enum(TEAM_BRAIN_STEPS).default('location'),
  /** Where the files live. Chosen first; null until chosen. */
  location: z.enum(TEAM_BRAIN_LOCATION_IDS).nullable().default(null),
  schedule: z.enum(TEAM_BRAIN_SCHEDULES).default('daily'),
  /** What each agent may do, by slug. An agent not listed reads and writes. */
  agentAccess: z.record(z.string(), z.enum([...TEAM_BRAIN_ACCESS, 'none'])).default({}),
})

export type TeamBrainState = z.infer<typeof teamBrainStateSchema>

export const TEAM_BRAIN_INITIAL_STATE: TeamBrainState = teamBrainStateSchema.parse({ status: 'off' })
