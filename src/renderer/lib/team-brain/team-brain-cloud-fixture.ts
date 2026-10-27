import type { FolderEntry } from '@renderer/hooks/use-folder-entries'
import type { CloudTeamBrain } from './team-brain-cloud'
import { TEAM_RECORD, TEAM_RECORD_FOLDER, type DriveListing } from './team-brain-drive'
import type { TeamBrainSync } from './team-brain-syncs'

/**
 * Stand-ins for what a cloud workspace would say about its Team Brain, until it can be asked (see team-brain-cloud.ts):
 * a small company wiki, its last few syncs' summaries, and the brain itself.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const pages = (folder: string, names: readonly string[]) => names.map((name) => `${folder}/${name}.md`)
const numbered = (folder: string, count: number, name: string) => Array.from({ length: count }, (_, i) => `${folder}/${name} ${i + 1}.md`)

/** Every page in the wiki, newest first. The summaries below link to some of them. */
const WIKI: readonly string[] = [
  'README.md',
  'INDEX.md',
  ...pages('customers', ['Acme Corp', 'Initech', 'Hooli', 'Northwind', 'Globex', 'Umbrella', 'Stark Industries', 'Wayne Enterprises', 'Soylent', 'Cyberdyne', 'Pied Piper', 'Massive Dynamic', 'Churn risks']),
  ...pages('marketing', ['Team Brain launch', 'Messaging', 'Brand voice']),
  ...pages('engineering', ['Bugs and triage', 'On-call', 'Architecture']),
  ...pages('product', ['Roadmap', 'Feedback themes', 'Pricing and packaging']),
  ...pages('people', ['Directory', 'Org chart', 'Onboarding', 'Holidays', 'Benefits', 'Hiring plan', 'Interview loop']),
  ...pages('sales', ['Playbook', 'Pricing', 'Discount policy', 'Objections', 'Competitors', 'Renewals', 'Demo script', 'Security questionnaire']),
  ...numbered('engineering/runbooks', 10, 'Runbook'),
  ...numbered('engineering/incidents', 9, 'Incident'),
  ...numbered('product/specs', 8, 'Spec'),
  ...numbered('product/decisions', 6, 'Decision'),
  ...numbered('marketing/campaigns', 7, 'Campaign'),
  ...['2026-10', '2026-09', '2026-08', '2026-07'].flatMap((month) => numbered(`meetings/${month}`, 3, 'Weekly sync')),
  ...pages(TEAM_RECORD_FOLDER, ['Rules', 'Sources', 'Changelog']),
]

/** The wiki listed folder by folder, as a drive's folders are, its pages changed a little apart going back from `now`. */
export function cloudBrainListing(now: number): DriveListing {
  const listing = new Map<string, FolderEntry[]>([['', []]])
  const add = (folder: string, entry: FolderEntry) => {
    const entries = listing.get(folder) ?? []
    listing.set(folder, entries)
    if (!entries.some((e) => e.path === entry.path)) entries.push(entry)
  }
  WIKI.forEach((path, i) => {
    const parts = path.split('/')
    parts.forEach((name, depth) => {
      const at = parts.slice(0, depth + 1).join('/')
      const folder = parts.slice(0, depth).join('/')
      const isFile = depth === parts.length - 1
      add(folder, isFile ? { name, path: at, type: 'file', mtimeMs: now - (i + 1) * 47 * MINUTE } : { name, path: at, type: 'directory' })
    })
  })
  return listing
}

/** How many pages the wiki holds, without the team record. */
const PAGE_COUNT = WIKI.filter((path) => !TEAM_RECORD.has(path.split('/')[0])).length

/** The Team Brain a cloud workspace has, in `workspace`. */
export function cloudTeamBrain(workspace: string, now: number = Date.now()): CloudTeamBrain {
  return {
    workspace,
    location: 'googledrive',
    place: 'Shared drives / Team Brain',
    schedule: 'daily',
    sources: ['slack', 'notion', 'gmail', 'linear', 'github'],
    pages: PAGE_COUNT,
    lastSyncAt: new Date(now - 2 * HOUR).toISOString(),
  }
}

/** A page of the wiki as the drawer shows it: its title, until pages can be read from the cloud. */
export function cloudBrainPage(path: string): string {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(`# ${title}\n\n_In your cloud workspace’s Team Brain. Read only._\n`)}`
}

/** The last few syncs' summaries, as an upkeep run writes them. */
export function sampleSyncs(now: number = Date.now()): TeamBrainSync[] {
  const at = (hours: number) => new Date(now - hours * HOUR).toISOString()
  return [
    {
      id: '_brain/syncs/dev-3.md',
      at: at(2),
      session: null,
      sources: ['slack', 'notion', 'gmail', 'linear'],
      added: 3,
      updated: 9,
      highlights: [
        { title: 'Acme’s renewal moves to Q1', body: 'Acme asked in #sales to push their renewal to Q1 while their budget resets. [Acme Corp](../../customers/Acme%20Corp.md) has the new date and the two people who sign off.' },
        { title: 'The Team Brain launch has a plan', body: 'Marketing’s launch brief landed in Notion. [Team Brain launch](../../marketing/Team%20Brain%20launch.md) has the date and the three messages to lead with.' },
      ],
      changes: ['Cycle 14 closed in Linear; [Roadmap](../../product/Roadmap.md) marks two projects shipped.', 'Four new bugs went into [Bugs and triage](../../engineering/Bugs%20and%20triage.md).'],
      needsYou: { blocked: ['Gmail asked to be reconnected, so threads after Tuesday were skipped.'], toDecide: ['Initech and Initech Ltd look like one customer. Filed both under [Initech](../../customers/Initech.md) for now.'] },
    },
    {
      id: '_brain/syncs/dev-2.md',
      at: at(26),
      session: null,
      sources: ['confluence', 'slack'],
      added: 2,
      updated: 6,
      highlights: [{ title: 'On-call has a runbook', body: 'The Ops space’s on-call guide came over from Confluence as [On-call](../../engineering/On-call.md), with the escalation path.' }],
      changes: ['Three more customers asked for SSO; [Feedback themes](../../product/Feedback%20themes.md) now puts it first.'],
      needsYou: { blocked: [], toDecide: [] },
    },
  ]
}
