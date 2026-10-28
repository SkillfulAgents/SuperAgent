import type { TeamBrainSourceId } from './team-brain-schema'

/**
 * The places Team Brain can read from. Icons come from the same service-icon
 * set the Connections page uses.
 */
export interface TeamBrainSource {
  id: TeamBrainSourceId
  name: string
  /** `public/service-icons/<slug>.svg` */
  iconSlug: string
  /** Monochrome marks (GitHub, Linear) need inverting on dark, as on the Connections page. */
  iconClassName?: string
}

export const TEAM_BRAIN_SOURCES: readonly TeamBrainSource[] = [
  {
    id: 'slack',
    name: 'Slack',
    iconSlug: 'slack',
  },
  {
    id: 'notion',
    name: 'Notion',
    iconSlug: 'notion',
  },
  {
    id: 'googledrive',
    name: 'Google Drive',
    iconSlug: 'googledrive',
  },
  {
    id: 'github',
    name: 'GitHub',
    iconSlug: 'github',
    iconClassName: 'dark:invert',
  },
  {
    id: 'linear',
    name: 'Linear',
    iconSlug: 'linear',
    iconClassName: 'dark:invert',
  },
  {
    id: 'confluence',
    name: 'Confluence',
    iconSlug: 'confluence',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    iconSlug: 'gmail',
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    iconSlug: 'dropbox',
  },
  {
    id: 'jira',
    name: 'Jira',
    iconSlug: 'jira',
  },
  {
    id: 'outlook',
    name: 'Outlook',
    iconSlug: 'outlook',
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    iconSlug: 'microsoft_teams',
  },
]

export function teamBrainSource(id: TeamBrainSourceId): TeamBrainSource {
  const source = TEAM_BRAIN_SOURCES.find((s) => s.id === id)
  if (!source) throw new Error(`Unknown Team Brain source: ${id}`)
  return source
}
