/**
 * Team Brain: one shared, agent-maintained wiki for the whole workspace, kept
 * on a drive its agent writes and the agents given access read. These are the
 * apps it can read from.
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
