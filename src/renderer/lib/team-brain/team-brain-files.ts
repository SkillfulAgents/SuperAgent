import type { TeamBrainNode } from './team-brain-structure'
import { teamBrainSource } from './team-brain-sources'
import { formatMinutesAgo } from './team-brain-format'

/**
 * What a page in the mock drive says when someone opens it. A few pages people
 * are likely to open first are written out; every other page is drafted from
 * its folder, the apps it is kept from and when it last changed, so any file
 * in the drive opens to something that reads like Team Brain wrote it.
 */

const WRITTEN: Record<string, string> = {
  readme: `# Team Brain

The shared memory for every agent in this workspace. Team Brain reads the places the team already works, keeps one page per thing worth knowing, and updates those pages as the sources change.

## How it is organised

- **Company** and **People**: who we are, how we work, who to ask.
- **Customers**, **Sales** and **Marketing**: accounts, how we sell, what is going out.
- **Brand**: how we look and sound. Agents check this before writing anything customer-facing.
- **Product** and **Engineering**: what we are building, the decisions behind it, how to run it.
- **Meetings**: notes and decisions, newest first.

## How to contribute

Agents with write access add what they learn; Team Brain files it on the next sync. People can edit any page directly, and Team Brain keeps their edits.`,

  'customers/acme': `# Acme Corp

Enterprise account, 240 seats, on the Team plan since March 2025.

## Where things stand

- **Renewal moved to Q1** after a thread in #sales: their budget cycle slipped and procurement asked for the new pricing first.
- Champion: **Dana Ruiz**, Head of Operations. Economic buyer: **Lee Park**, CFO.
- Open request: SSO with Okta, needed before they expand to the support team.

## History

- 2026-10-12: QBR. Usage up 30% since summer; agents run most of their weekly reporting.
- 2026-08-03: Added 40 seats for the London office.

## Sources

Kept up to date from Gmail threads with @acme.com and #sales in Slack.`,

  'product/roadmap': `# Roadmap

What we are building this quarter and next, synced from Linear every sync.

## Now (Cycle 15)

- **Team Brain**: shared memory for every agent, set up in a guided chat.
- **Voice mode**: hands-free sessions, with the hold sound handed to your music player.

## Next

- SSO for workspaces (asked for by Acme and Hooli).
- Agent home redesign.

## Recently shipped

- Cycle 14 closed: shared drives went global, and drive health checks shipped.`,

  'brand/guidelines': `# Brand guidelines

## Voice

Plain and specific. Say what something does, then stop. No exclamation marks in product copy.

## Visual

- One accent colour, used for the primary action on a screen and nothing else.
- Type never heavier than medium.
- Generous whitespace; let one thing on the page lead.

## For agents

Before writing anything customer-facing, read **Voice and tone** and **Messaging framework** in this folder.`,

  'company/team': `# Team directory

Who is on the team, what they own and where to find them.

| Name | Role | Owns |
| --- | --- | --- |
| Maya Patel | Engineering | Agent runtime, drives |
| Leo Grant | Design | Product design, brand |
| Priya Nair | Sales | Enterprise accounts |
| Marco Silva | Support | Customer onboarding |

Kept up to date from the Slack member list and the Notion team page.`,

  'product/decisions/0009': `# 0009 Pricing change

**Status:** accepted · **Date:** this week

## Decision

Move from per-agent to per-seat pricing for the Team plan, with agents unlimited.

## Why

Customers kept asking how many agents they could run before it got expensive, and the answer slowed every deal. Per-seat matches how they budget.

## Alternatives considered

- Usage-based pricing on agent runs: fair, but hard to predict.
- Keeping per-agent pricing with a larger free tier.`,
}

function draft(node: TeamBrainNode, folder: TeamBrainNode | undefined): string {
  const title = node.name.replace(/\.md$/, '')
  const apps = node.sources.map((id) => teamBrainSource(id).name)
  const kept = apps.length > 0 ? apps.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'what agents added'
  const updated = node.updatedMinutesAgo !== undefined ? formatMinutesAgo(node.updatedMinutesAgo) : 'recently'
  return `# ${title}

${folder?.summary ?? ''}

_Kept up to date from ${kept}. Last updated ${updated}._

## What is here

- The current state, written so any agent can act on it without asking first.
- Where it came from, with links back to the threads and docs it was built from.
- Open questions Team Brain is still tracking.

## Recent changes

- ${updated[0].toUpperCase()}${updated.slice(1)}: refreshed from ${apps[0] ?? 'an agent'}.`
}

/** The page's text, as markdown. `folder` is the folder it sits in, if any. */
export function teamBrainFileMarkdown(node: TeamBrainNode, folder?: TeamBrainNode): string {
  return WRITTEN[node.id] ?? draft(node, folder)
}
