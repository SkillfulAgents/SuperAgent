import { z } from 'zod'
import { VOLUME_TYPES } from '@shared/lib/types/mount'

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
export type TeamBrainStep = (typeof TEAM_BRAIN_STEPS)[number]

/** The workspace's one Team Brain: its agent and its drive. */
export const teamBrainRecordSchema = z.object({ agentSlug: z.string().min(1), volumeId: z.string().min(1) }).strict()
export type TeamBrainRecord = z.infer<typeof teamBrainRecordSchema>

/** What a set-up chooses after its drive: how far it got, and which agents use Team Brain. */
export const teamBrainChoicesSchema = z.object({
  step: z.enum(TEAM_BRAIN_STEPS),
  schedule: z.enum(TEAM_BRAIN_SCHEDULES),
  /** Every agent, including ones made later: the drive goes global, read-only. */
  everyAgent: z.boolean(),
  /** Agents switched on or off one by one, by slug. An agent not listed follows `everyAgent`. */
  agents: z.record(z.string(), z.boolean()),
}).strict()
export type TeamBrainChoices = z.infer<typeof teamBrainChoicesSchema>

/**
 * A set-up in progress, claimed before its agent and drive exist. Each id is
 * saved the moment its agent or drive is made. `setupId` tells this set-up
 * from one started after it was discarded.
 */
export const teamBrainSetupSchema = teamBrainChoicesSchema.extend({
  status: z.literal('setting-up'),
  setupId: z.string().min(1),
  agentSlug: z.string().nullable(),
  volumeId: z.string().nullable(),
  location: z.enum(TEAM_BRAIN_LOCATION_IDS).nullable(),
}).strict()
export type TeamBrainSetup = z.infer<typeof teamBrainSetupSchema>

/** The settings' Team Brain: a set-up in progress, or the Team Brain once Finish marked it ready. */
export const teamBrainStoredSchema = z.union([teamBrainSetupSchema, teamBrainRecordSchema])
export type TeamBrainStored = z.infer<typeof teamBrainStoredSchema>

/**
 * A set-up as a page resumes it: the record, and whether what it names is still there. Its agent or drive can be
 * deleted by hand, or a tab closed between making one and saving it; step 1 is done only when the agent has the drive.
 */
export interface TeamBrainSetupView {
  readonly setup: TeamBrainSetup
  /** The set-up's agent exists. */
  readonly agent: boolean
  /** The set-up's drive is attached to that agent. */
  readonly drive: boolean
}

/** The ready Team Brain, or null: none, or a set-up still running. */
export function readyTeamBrain(stored: TeamBrainStored | null | undefined): TeamBrainRecord | null {
  return stored && !('status' in stored) ? stored : null
}
