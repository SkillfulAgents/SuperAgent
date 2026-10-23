import type { TeamBrainSourceId } from './team-brain-schema'

/**
 * What each sync did, for the live page's sync summaries. On every sync Team
 * Brain reads what is new in its sources and files it into the drive, then
 * writes up what changed the way a changelog does: the few changes worth a
 * paragraph, then the rest a line each. Newest first, one per sync.
 * Prototype data, written to read like a real team's week.
 *
 * Pages are linked as a wiki links them, `[[Customers/Acme Corp]]`: the
 * page's path in the drive, without `.md`. `{agent}` stands for an agent
 * that messaged Team Brain something worth keeping between syncs.
 */
export interface TeamBrainSync {
  id: string
  /** The apps it found something new in. */
  sources: TeamBrainSourceId[]
  added: number
  updated: number
  /** The changes worth a few sentences each. */
  highlights: { title: string; body: string }[]
  /** Everything else it filed, a line each. */
  changes: string[]
}

export const TEAM_BRAIN_SYNCS: readonly TeamBrainSync[] = [
  {
    id: 's5',
    sources: ['slack', 'notion', 'gmail', 'linear', 'jira'],
    added: 3,
    updated: 9,
    highlights: [
      {
        title: 'Acme’s renewal moves to Q1',
        body: 'Acme asked in #sales to push their renewal to Q1 while their budget resets. [[Customers/Acme Corp]] has the new date and the two people who sign off, and [[Customers/Churn risks]] now lists it as one to watch.',
      },
      {
        title: 'The Team Brain launch has a plan',
        body: 'Marketing’s launch brief landed in Notion. [[Marketing/Launch plans/Team Brain launch]] has the date, who it is for and the three messages to lead with, and the spec in [[Product/Specs/Team Brain]] links to it.',
      },
    ],
    changes: [
      '{agent} told Team Brain what it learned about the pricing change; it is filed as [[Product/Decisions/0009 Pricing change]].',
      'Cycle 14 closed in Linear; [[Product/Roadmap]] marks two projects shipped.',
      'Four new bugs went into [[Product/Bugs and triage]], one of them a release blocker.',
      'Hooli’s procurement asked for a security review; [[Customers/Hooli]] has the new contacts.',
    ],
  },
  {
    id: 's4',
    sources: ['confluence', 'slack', 'notion'],
    added: 2,
    updated: 6,
    highlights: [
      {
        title: 'On-call has a runbook',
        body: 'The Ops space’s on-call guide came over from Confluence as [[Engineering/Runbooks/On-call]], with the escalation path and who holds the pager this week. [[Engineering/Runbooks/Incident response]] now starts from it.',
      },
    ],
    changes: [
      'Three more customers asked for SSO; [[Customers/Feedback themes]] now puts it first.',
      'Monday’s notes and action items are in [[Meetings/Weekly sync/2026-10-20]].',
      '[[Company/Glossary]] picked up two terms from #eng: global drive and fork.',
    ],
  },
  {
    id: 's3',
    sources: ['github', 'googledrive', 'slack'],
    added: 1,
    updated: 4,
    highlights: [
      {
        title: 'Drives are global, decided',
        body: 'The decision to let admins mount one drive for every agent is written up in [[Product/Decisions/0008 Drives are global]], from the pull request and a thread in #product. [[Product/Specs/Shared drives]] points to it for the why.',
      },
    ],
    changes: [
      'Release notes for 0.5.46 are in [[Product/Release notes/0.5.46]].',
      '[[Company/OKRs/2026 Q4]] has the revised activation target.',
    ],
  },
  {
    id: 's2',
    sources: ['gmail', 'outlook', 'notion'],
    added: 2,
    updated: 3,
    highlights: [
      {
        title: 'Initech kicks off',
        body: 'Initech signed. [[Meetings/Customer calls/Initech kickoff]] sums up the kickoff call, and [[Customers/Initech]] has their rollout plan and admin contacts.',
      },
    ],
    changes: [
      '[[Sales/Competitors/Battlecard: Relay]] notes Relay’s new pricing page.',
      '[[People/Onboarding/Who to ask]] is up to date after the moves in Engineering.',
    ],
  },
  {
    id: 's1',
    sources: ['notion', 'jira', 'googledrive'],
    added: 0,
    updated: 3,
    highlights: [],
    changes: [
      '[[Brand/Voice and tone]] adds guidance for copy in the product.',
      '[[Engineering/Current sprint]] rolled over to sprint 42.',
      '[[Company/Policies/Expenses]] raises the home-office allowance.',
    ],
  },
]

/** A summary's text in pieces: plain words, a linked page (by its path, without `.md`), or the agent that filed one. */
export type SyncSummaryPart = { text: string } | { page: string } | { agent: true }

export function syncSummaryParts(text: string): SyncSummaryPart[] {
  const parts: SyncSummaryPart[] = []
  let at = 0
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]|\{agent\}/g)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index) })
    parts.push(match[1] ? { page: match[1] } : { agent: true })
    at = match.index + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
