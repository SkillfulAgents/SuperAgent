import type { TeamBrainSourceId } from './team-brain-schema'

/**
 * The places Team Brain can read from. Prototype catalogue: icons come from
 * the same service-icon set the Connections page uses, and `research` is the
 * made-up tally the onboarding's research step counts up to.
 */
export interface TeamBrainSource {
  id: TeamBrainSourceId
  name: string
  /** `public/service-icons/<slug>.svg` */
  iconSlug: string
  /** Monochrome marks (GitHub, Linear) need inverting on dark, as on the Connections page. */
  iconClassName?: string
  /** What Team Brain would take from it, in a few words. */
  blurb: string
  research: {
    /** What the scan reports while it runs, e.g. "channels". */
    unit: string
    /** How many of them it finds. */
    count: number
    /** The headline once done, e.g. "2,318 messages · 37 topics". */
    summary: string
    /** What it turns up along the way, shown as they surface during ingestion. */
    topics: string[]
  }
}

export const TEAM_BRAIN_SOURCES: readonly TeamBrainSource[] = [
  {
    id: 'slack',
    name: 'Slack',
    iconSlug: 'slack',
    blurb: 'Decisions made in threads, announcements, the channel where things actually get settled.',
    research: { unit: 'channels', count: 14, summary: '2,318 messages · 37 topics', topics: ['Acme renewal', 'On-call handoffs', 'Q4 planning', 'Pricing questions'] },
  },
  {
    id: 'notion',
    name: 'Notion',
    iconSlug: 'notion',
    blurb: 'Specs, meeting notes, the docs your team already writes.',
    research: { unit: 'pages', count: 86, summary: '86 pages · 12 databases', topics: ['Product specs', 'Weekly sync notes', 'Hiring plan'] },
  },
  {
    id: 'googledrive',
    name: 'Google Drive',
    iconSlug: 'googledrive',
    blurb: 'Docs, sheets and decks, including the ones nobody can find.',
    research: { unit: 'files', count: 142, summary: '142 files · 9 shared folders', topics: ['Board deck', 'Pricing sheet', 'Brand guidelines'] },
  },
  {
    id: 'github',
    name: 'GitHub',
    iconSlug: 'github',
    iconClassName: 'dark:invert',
    blurb: 'READMEs, architecture decisions, the reasoning in pull request threads.',
    research: { unit: 'repositories', count: 9, summary: '9 repos · 41 design docs', topics: ['Architecture decisions', 'Release process', 'API conventions'] },
  },
  {
    id: 'linear',
    name: 'Linear',
    iconSlug: 'linear',
    iconClassName: 'dark:invert',
    blurb: 'Projects, cycles and what shipped when.',
    research: { unit: 'projects', count: 23, summary: '23 projects · 6 active cycles', topics: ['Roadmap', 'Cycle 14', 'Shared drives'] },
  },
  {
    id: 'confluence',
    name: 'Confluence',
    iconSlug: 'confluence',
    blurb: 'Wiki spaces and runbooks.',
    research: { unit: 'spaces', count: 3, summary: '3 spaces · 210 pages', topics: ['Runbooks', 'Incident reviews'] },
  },
  {
    id: 'gmail',
    name: 'Gmail',
    iconSlug: 'gmail',
    blurb: 'Threads with customers and partners. Only what you share.',
    research: { unit: 'threads', count: 1120, summary: '1,120 threads · 58 contacts', topics: ['Northwind', 'Globex', 'Partner terms'] },
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    iconSlug: 'dropbox',
    blurb: 'Shared folders and the files that live in them.',
    research: { unit: 'files', count: 64, summary: '64 files · 4 shared folders', topics: ['Brand assets', 'Contracts'] },
  },
  {
    id: 'jira',
    name: 'Jira',
    iconSlug: 'jira',
    blurb: 'Projects and tickets, for the teams that plan there.',
    research: { unit: 'projects', count: 11, summary: '11 projects · 640 issues', topics: ['Platform migration', 'Support escalations'] },
  },
  {
    id: 'outlook',
    name: 'Outlook',
    iconSlug: 'outlook',
    blurb: 'Mail and calendar on Microsoft 365.',
    research: { unit: 'threads', count: 860, summary: '860 threads · 41 contacts', topics: ['Vendor contracts', 'Board prep'] },
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    iconSlug: 'microsoft_teams',
    blurb: 'Channels and chats on Microsoft 365.',
    research: { unit: 'channels', count: 9, summary: '1,204 messages · 18 topics', topics: ['Partner sync', 'Ops handoffs'] },
  },
]

export function teamBrainSource(id: TeamBrainSourceId): TeamBrainSource {
  const source = TEAM_BRAIN_SOURCES.find((s) => s.id === id)
  if (!source) throw new Error(`Unknown Team Brain source: ${id}`)
  return source
}
