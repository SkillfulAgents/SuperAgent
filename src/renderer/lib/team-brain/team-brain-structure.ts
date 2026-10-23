import type { TeamBrainSourceId } from './team-brain-schema'

/**
 * What Team Brain's drive holds, for the home page's tree until it can list
 * the real drive. Prototype data, chosen to read like a real team's wiki,
 * nested up to five levels deep.
 */
export interface TeamBrainNode {
  /** Stable id, used for include/exclude and as a React key. */
  id: string
  name: string
  kind: 'folder' | 'file'
  /** One line on what lives here. */
  summary?: string
  /** Which connected sources feed this node. Empty = Team Brain's own. */
  sources: TeamBrainSourceId[]
  children?: TeamBrainNode[]
  /** Live-state decoration: how long ago Team Brain last touched it, in minutes. */
  updatedMinutesAgo?: number
}

const H = 60
const D = 24 * H

/** A page Team Brain keeps, fed by `sources`, last touched `updated` minutes ago. */
function file(id: string, name: string, sources: TeamBrainSourceId[], updated: number): TeamBrainNode {
  return { id, name, kind: 'file', sources, updatedMinutesAgo: updated }
}

function folder(id: string, name: string, summary: string, sources: TeamBrainSourceId[], children: TeamBrainNode[]): TeamBrainNode {
  return { id, name, kind: 'folder', summary, sources, children }
}

export const TEAM_BRAIN_STRUCTURE: readonly TeamBrainNode[] = [
  {
    id: 'readme',
    name: 'README.md',
    kind: 'file',
    summary: 'Start here: what Team Brain is, how it is organised, how to contribute.',
    sources: [],
    updatedMinutesAgo: 3 * D,
  },
  folder('company', 'Company', 'Who we are, what we are building and why.', ['notion', 'slack', 'googledrive', 'confluence'], [
    file('company/about', 'About us.md', ['notion'], 14 * D),
    file('company/mission', 'Mission and strategy.md', ['notion'], 6 * D),
    file('company/values', 'Values.md', ['notion'], 30 * D),
    file('company/team', 'Team directory.md', ['slack', 'notion'], 2 * D),
    file('company/org-chart', 'Org chart.md', ['googledrive'], 9 * D),
    file('company/glossary', 'Glossary.md', ['slack'], 45),
    file('company/rituals', 'Rituals and cadence.md', ['notion'], 9 * D),
    folder('company/okrs', 'OKRs', 'Goals by quarter, and how the last ones went.', ['googledrive', 'notion'], [
      file('company/okrs/2026-q4', '2026 Q4.md', ['googledrive'], 3 * D),
      file('company/okrs/2026-q3-review', '2026 Q3 review.md', ['notion'], 20 * D),
    ]),
    folder('company/policies', 'Policies', 'How we spend, take time off and keep things secure.', ['notion', 'googledrive', 'confluence'], [
      file('company/policies/expenses', 'Expenses.md', ['googledrive'], 40 * D),
      file('company/policies/time-off', 'Time off.md', ['notion'], 25 * D),
      file('company/policies/security', 'Security and access.md', ['confluence'], 11 * D),
      folder('company/policies/it', 'IT', 'Equipment and accounts, and how access is checked.', ['confluence', 'googledrive'], [
        file('company/policies/it/laptops', 'Laptops.md', ['googledrive'], 50 * D),
        file('company/policies/it/access-reviews', 'Access reviews.md', ['confluence'], 7 * D),
      ]),
    ]),
  ]),
  folder('people', 'People', 'Joining, growing and getting help.', ['notion', 'googledrive'], [
    folder('people/onboarding', 'Onboarding', 'A new teammate’s first weeks, in order.', ['notion'], [
      file('people/onboarding/first-week', 'First week.md', ['notion'], 5 * D),
      file('people/onboarding/tools', 'Accounts and tools.md', ['notion'], 5 * D),
      file('people/onboarding/who-to-ask', 'Who to ask.md', ['notion'], 2 * D),
    ]),
    file('people/handbook', 'Handbook.md', ['notion'], 18 * D),
    file('people/benefits', 'Benefits.md', ['googledrive'], 60 * D),
    file('people/reviews', 'Performance reviews.md', ['googledrive'], 33 * D),
  ]),
  folder('customers', 'Customers', 'One page per account: context, contacts, open threads, what they asked for.', ['gmail', 'slack', 'notion', 'outlook'], [
    file('customers/acme', 'Acme Corp.md', ['gmail', 'slack'], 12),
    file('customers/hooli', 'Hooli.md', ['slack', 'gmail'], 2 * H),
    file('customers/northwind', 'Northwind.md', ['gmail'], 5 * H),
    file('customers/globex', 'Globex.md', ['slack'], 26 * H),
    file('customers/initech', 'Initech.md', ['outlook', 'gmail'], 3 * D),
    file('customers/umbrella', 'Umbrella Health.md', ['gmail'], 6 * D),
    file('customers/playbook', 'Account playbook.md', ['notion'], 4 * D),
    file('customers/feedback', 'Feedback themes.md', ['slack', 'notion'], 8 * H),
    file('customers/churn', 'Churn risks.md', ['slack'], D),
  ]),
  folder('sales', 'Sales', 'How we find, pitch and close, and who we are up against.', ['notion', 'googledrive', 'slack'], [
    folder('sales/playbooks', 'Playbooks', 'Step by step, from first call to signed order.', ['notion', 'googledrive'], [
      file('sales/playbooks/discovery', 'Discovery call.md', ['notion'], 12 * D),
      file('sales/playbooks/demo', 'Demo script.md', ['notion'], 4 * D),
      file('sales/playbooks/objections', 'Objection handling.md', ['notion'], 7 * D),
      file('sales/playbooks/pricing', 'Pricing and packaging.md', ['googledrive'], 2 * D),
    ]),
    folder('sales/competitors', 'Competitors', 'Who else they are talking to, and how we win.', ['notion', 'slack'], [
      file('sales/competitors/overview', 'Competitive landscape.md', ['notion'], 10 * D),
      file('sales/competitors/relay', 'Battlecard: Relay.md', ['notion', 'slack'], 3 * D),
      file('sales/competitors/orbit', 'Battlecard: Orbit.md', ['notion'], 15 * D),
    ]),
    file('sales/pipeline', 'Pipeline review notes.md', ['googledrive'], 2 * D),
  ]),
  folder('marketing', 'Marketing', 'Launches, campaigns and what is going out when.', ['notion', 'googledrive'], [
    folder('marketing/launches', 'Launch plans', 'One plan per launch: audience, message, dates.', ['notion'], [
      file('marketing/launches/team-brain', 'Team Brain launch.md', ['notion'], 30),
      file('marketing/launches/voice', 'Voice mode launch.md', ['notion'], 9 * D),
    ]),
    file('marketing/calendar', 'Content calendar.md', ['googledrive'], 20 * H),
    file('marketing/results', 'Campaign results.md', ['googledrive'], 5 * D),
  ]),
  folder('brand', 'Brand', 'How we look and sound, so every agent stays on brand.', ['googledrive', 'notion', 'dropbox'], [
    file('brand/guidelines', 'Brand guidelines.md', ['googledrive'], 21 * D),
    file('brand/voice', 'Voice and tone.md', ['notion'], 13 * D),
    file('brand/messaging', 'Messaging framework.md', ['notion'], 6 * D),
    file('brand/assets', 'Logos and assets.md', ['dropbox'], 45 * D),
  ]),
  folder('product', 'Product', 'Roadmap, specs and the decisions behind them.', ['linear', 'notion', 'github', 'slack', 'googledrive', 'jira'], [
    file('product/roadmap', 'Roadmap.md', ['linear'], 70),
    folder('product/specs', 'Specs', 'Current specs, one file each, with status.', ['notion'], [
      file('product/specs/team-brain', 'Team Brain.md', ['notion'], 20),
      file('product/specs/voice', 'Voice mode.md', ['notion'], 3 * H),
      file('product/specs/drives', 'Shared drives.md', ['notion'], 30 * H),
      file('product/specs/agent-home', 'Agent home redesign.md', ['notion'], 8 * D),
      folder('product/specs/archive', 'Archive', 'Specs that shipped or were dropped, kept for the reasoning.', ['notion'], [
        folder('product/specs/archive/2025', '2025', 'Last year’s specs.', ['notion'], [
          file('product/specs/archive/2025/onboarding-v1', 'Onboarding v1.md', ['notion'], 120 * D),
          file('product/specs/archive/2025/teams-v1', 'Teams v1.md', ['notion'], 95 * D),
        ]),
      ]),
    ]),
    folder('product/decisions', 'Decisions', 'Architecture and product decisions, dated, with the alternatives considered.', ['github', 'slack'], [
      file('product/decisions/0007', '0007 Batches not transactions.md', ['github'], 12 * D),
      file('product/decisions/0008', '0008 Drives are global.md', ['github', 'slack'], D),
      file('product/decisions/0009', '0009 Pricing change.md', ['slack'], 55),
    ]),
    folder('product/research', 'Research', 'What users told us, and what we did about it.', ['notion', 'googledrive'], [
      file('product/research/interviews', 'User interviews, Q4.md', ['googledrive'], 4 * D),
      file('product/research/onboarding', 'Onboarding study.md', ['notion'], 16 * D),
    ]),
    folder('product/releases', 'Release notes', 'What shipped in each version.', ['github', 'linear'], [
      file('product/releases/0.5.46', '0.5.46.md', ['github'], 6 * H),
      file('product/releases/0.5.45', '0.5.45.md', ['github'], 4 * D),
    ]),
    file('product/triage', 'Bugs and triage.md', ['jira'], 90),
  ]),
  folder('engineering', 'Engineering', 'How the system fits together and how to operate it.', ['github', 'confluence', 'jira'], [
    file('engineering/architecture', 'Architecture overview.md', ['github'], 2 * D),
    folder('engineering/services', 'Services', 'One page per service: what it owns, how to run it.', ['github'], [
      file('engineering/services/api', 'API.md', ['github'], 3 * D),
      file('engineering/services/agent-container', 'Agent container.md', ['github'], D),
      file('engineering/services/desktop', 'Desktop app.md', ['github'], 5 * D),
      folder('engineering/services/integrations', 'Integrations', 'How each connected app is read, one folder per app.', ['github'], [
        file('engineering/services/integrations/overview', 'Overview.md', ['github'], 4 * D),
        folder('engineering/services/integrations/slack', 'Slack', 'Events, limits and what Team Brain keeps from each channel.', ['github'], [
          file('engineering/services/integrations/slack/events', 'Events.md', ['github'], 2 * D),
          file('engineering/services/integrations/slack/rate-limits', 'Rate limits.md', ['github'], 9 * D),
        ]),
        folder('engineering/services/integrations/googledrive', 'Google Drive', 'Sync and sharing for files in Drive.', ['github'], [
          file('engineering/services/integrations/googledrive/sync', 'Sync.md', ['github'], 3 * D),
          file('engineering/services/integrations/googledrive/permissions', 'Permissions.md', ['github'], 12 * D),
        ]),
      ]),
    ]),
    folder('engineering/runbooks', 'Runbooks', 'What to do when something breaks.', ['confluence'], [
      file('engineering/runbooks/oncall', 'On-call.md', ['confluence'], 3 * H),
      file('engineering/runbooks/incidents', 'Incident response.md', ['confluence'], 8 * D),
      file('engineering/runbooks/deploys', 'Deploys and rollbacks.md', ['confluence'], 6 * D),
      file('engineering/runbooks/restores', 'Database restores.md', ['confluence'], 27 * D),
    ]),
    file('engineering/release', 'Release process.md', ['github'], 5 * D),
    file('engineering/standards', 'Coding standards.md', ['github'], 19 * D),
    file('engineering/sprints', 'Current sprint.md', ['jira'], 4 * H),
  ]),
  folder('meetings', 'Meetings', 'Notes and decisions from recurring meetings, newest first.', ['notion', 'googledrive', 'slack', 'teams', 'gmail', 'outlook'], [
    folder('meetings/weekly', 'Weekly sync', 'One file per week.', ['notion', 'googledrive'], [
      file('meetings/weekly/2026-10-20', '2026-10-20.md', ['notion'], 26 * H),
      file('meetings/weekly/2026-10-13', '2026-10-13.md', ['notion'], 8 * D),
      file('meetings/weekly/2026-10-06', '2026-10-06.md', ['googledrive'], 15 * D),
    ]),
    folder('meetings/all-hands', 'All-hands', 'Monthly, with the slides and the questions asked.', ['googledrive', 'teams'], [
      folder('meetings/all-hands/2026', '2026', 'This year’s, newest first.', ['googledrive', 'teams'], [
        file('meetings/all-hands/2026-10', 'October all-hands.md', ['googledrive', 'teams'], 2 * D),
        file('meetings/all-hands/2026-09', 'September all-hands.md', ['googledrive'], 32 * D),
      ]),
      folder('meetings/all-hands/2025', '2025', 'Last year’s.', ['googledrive'], [
        file('meetings/all-hands/2025-12', 'December all-hands.md', ['googledrive'], 300 * D),
      ]),
    ]),
    folder('meetings/customer-calls', 'Customer calls', 'Notes from calls with accounts, linked to their pages.', ['gmail', 'outlook'], [
      file('meetings/customer-calls/acme-qbr', 'Acme QBR.md', ['gmail'], 3 * D),
      file('meetings/customer-calls/initech-kickoff', 'Initech kickoff.md', ['outlook'], 6 * D),
    ]),
    file('meetings/decisions', 'Decisions log.md', ['slack'], 55),
  ]),
]

/**
 * The drive narrowed to what the given sources can feed. A node with no
 * sources (the README) is always there; a node whose sources are all
 * unconnected is left out, and folders keep only the children that survive.
 */
export function teamBrainDrive(connected: readonly TeamBrainSourceId[], excluded: readonly string[] = []): TeamBrainNode[] {
  const has = new Set(connected)
  const keep = (node: TeamBrainNode): TeamBrainNode | null => {
    if (excluded.includes(node.id)) return null
    if (node.sources.length > 0 && !node.sources.some((s) => has.has(s))) return null
    if (node.kind === 'file') return node
    const children = (node.children ?? []).map(keep).filter((c): c is TeamBrainNode => c !== null)
    return { ...node, children }
  }
  return TEAM_BRAIN_STRUCTURE.map(keep).filter((n): n is TeamBrainNode => n !== null)
}

export function countNodes(nodes: readonly TeamBrainNode[]): { folders: number; files: number } {
  let folders = 0
  let files = 0
  const walk = (list: readonly TeamBrainNode[]) => {
    for (const n of list) {
      if (n.kind === 'folder') {
        folders++
        walk(n.children ?? [])
      } else files++
    }
  }
  walk(nodes)
  return { folders, files }
}
