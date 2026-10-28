import { BookOpen, Code2, FileText, type LucideIcon } from 'lucide-react'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'
import { DEFAULT_ORBS } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { avatarSource, type AvatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { ORB_SHAPES } from '@renderer/components/agents/agent-avatar/orb-shapes'

/**
 * Presentation helpers for marketplace templates.
 *
 * Everything here maps or formats data the skillset repo's `index.json`
 * actually provides — name, description, category, tags, connections,
 * developer, and the long-form details markdown. Nothing is invented: run
 * cost and suggested models used to be mocked here and were removed rather
 * than shown as fact.
 */

// ── Avatars ──────────────────────────────────────────────────────────────────

/**
 * A template's orb: the `avatar` its skillset names, or — for a skillset that
 * names none — a colour from the default palette and a shape, each hashed from
 * the template name, so a template always looks the same. The public skillset
 * seeds its avatars from this same hash. The index's `icon` is no longer drawn.
 */
export function getTemplateAvatar(template: ApiDiscoverableAgent): AvatarSource {
  if (template.avatar) return avatarSource(template.avatar)
  return {
    orb: DEFAULT_ORBS[hashString(template.name) % DEFAULT_ORBS.length],
    shape: ORB_SHAPES[hashString(`${template.name}:shape`) % ORB_SHAPES.length],
  }
}

/**
 * Stable 32-bit hash. The avalanche step matters: a plain `*31` accumulator
 * keeps its low bits correlated with the character sum, which clusters hard
 * under a small modulo (our first roster landed on 2 of 6 colors without it).
 */
function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d) >>> 0
  hash ^= hash >>> 15
  return hash >>> 0
}

/**
 * The hero wash in the template's orb colours: the rim strong in one corner,
 * through the core, fading to nothing so the grey underneath still reads as
 * the base. Alpha is appended as hex — 30% (4D) and 10% (1A).
 */
export function getTemplateGradient(template: ApiDiscoverableAgent): string {
  const { orb } = getTemplateAvatar(template)
  return `linear-gradient(to top left, ${orb.rim}4D, ${orb.core}1A, transparent)`
}

// ── Categories ───────────────────────────────────────────────────────────────

/**
 * Categories come from the index verbatim, but the repo has near-duplicates
 * ("Ops" and "Operations", "Email & Communication" alongside "Productivity").
 * Fold those together so the filter list stays short.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  Operations: 'Ops',
  'Email & Communication': 'Productivity',
  'Human Resources': 'Recruiting',
  'Health & Fitness': 'Personal',
  'Design & Creative': 'Marketing',
  'Agent Creation': 'Productivity',
}

export function templateCategory(template: ApiDiscoverableAgent): string | undefined {
  const raw = template.category?.trim()
  if (!raw) return undefined
  return CATEGORY_ALIASES[raw] ?? raw
}


/**
 * TODO: switch this to a real `featured` flag once the skillset READMEs carry
 * one. Authorship is a stand-in, and it gets the two obvious cases wrong: a
 * contributor shipping something excellent can never be featured, and anything
 * mediocre we publish always is. The flag belongs in the README frontmatter
 * beside `category` and `icon`, which means adding it to SkillsetIndexAgent
 * and its Zod schema; this predicate then reads `template.featured === true`.
 *
 * Until then: templates authored by us rather than contributed — the 8
 * hand-built agents that predate the bulk Bot Directory import, and the only
 * ones shipping real `.claude/skills/` directories.
 */
export const FEATURED_SECTION_LABEL = 'Featured'

const FIRST_PARTY_DEVELOPER = 'SkillfulAgents'

export function isFeaturedTemplate(template: ApiDiscoverableAgent): boolean {
  return template.developer?.name === FIRST_PARTY_DEVELOPER
}

// ── Connections ──────────────────────────────────────────────────────────────

/**
 * Not every slug the index names has an SVG in public/service-icons (`granola`
 * and `microsoft_teams` don't today). Those are left to `ServiceIcon`'s own
 * onError fallback — a generic glyph beside the service's NAME still says which
 * service it is, and deriving it from the actual load keeps no list to rot as
 * the index and the icon set each move on.
 */

/** Human label for a connection slug (the index only carries the slug). */
export function connectionLabel(slug: string): string {
  return CONNECTION_LABELS[slug] ?? slug.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const CONNECTION_LABELS: Record<string, string> = {
  ahrefs: 'Ahrefs',
  airtable: 'Airtable',
  datadog: 'Datadog',
  dataforseo: 'DataForSEO',
  discord: 'Discord',
  figma: 'Figma',
  github: 'GitHub',
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googledocs: 'Google Docs',
  googledrive: 'Google Drive',
  googlesheets: 'Google Sheets',
  googleslides: 'Google Slides',
  granola: 'Granola',
  intercom: 'Intercom',
  linear: 'Linear',
  linkedin: 'LinkedIn',
  microsoft_teams: 'Microsoft Teams',
  notion: 'Notion',
  outlook: 'Outlook',
  posthog: 'PostHog',
  quickbooks: 'QuickBooks',
  salesforce: 'Salesforce',
  slack: 'Slack',
  stripe: 'Stripe',
  webflow: 'Webflow',
  xero: 'Xero',
  youtube: 'YouTube',
  zendesk: 'Zendesk',
  zoom: 'Zoom',
}

// ── Details markdown ─────────────────────────────────────────────────────────

export interface TemplateDetailSection {
  title: string
  body: string
}

/** Authored prompts for the hero band — what a template should carry. */
export const EXAMPLE_PROMPTS_SECTION_TITLE = 'Example prompts'

/** The older heading, still the only one most imported templates have. */
export const USE_CASES_SECTION_TITLE = 'Sample use cases'

/**
 * `Connect first` lists exactly the services already shown in Works with,
 * directly above it; the two prompt sections are lifted into the hero band.
 * All three would otherwise appear twice on one page.
 */
const SKIPPED_DETAIL_SECTIONS = new Set([
  'Connect first',
  EXAMPLE_PROMPTS_SECTION_TITLE,
  USE_CASES_SECTION_TITLE,
])

/**
 * Bullet lines of a section, stripped of their markers and trailing period. A
 * question mark is left alone — example prompts are often questions. Dash
 * variants are accepted since authors reach for en/em dashes by habit.
 */
export function parseBullets(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.match(/^\s*[-*•–—]\s+(.*)$/)?.[1]?.trim())
    .filter((text): text is string => Boolean(text))
    .map((text) => text.replace(/\.$/, ''))
}

/** The body of one `##` section, or undefined when the template has none. */
function sectionBody(details: string | undefined, title: string): string | undefined {
  if (!details) return undefined
  const chunk = details
    .split(/^##[ \t]+/m)
    .slice(1)
    .find((c) => c.split('\n')[0].trim() === title)
  return chunk ? chunk.slice(chunk.indexOf('\n') + 1) : undefined
}

/** The `Sample use cases` bullets, or empty when the template has none. */
export function getTemplateUseCases(details: string | undefined): string[] {
  return parseBullets(sectionBody(details, USE_CASES_SECTION_TITLE) ?? '')
}

/**
 * Openers used to top the hero up to three pills. Every agent in the roster
 * ships exactly two use cases (or none), so at least one is always needed —
 * these read as things you could actually type on a first run.
 */
const GENERIC_EXAMPLES = [
  'Help me get started',
  'What can you do?',
  'Walk me through your first run',
]

/**
 * Exactly three example prompts. Authored `Example prompts` win outright —
 * they're written to be typed. Templates without them (most of the imported
 * roster) fall back to `Sample use cases`, then to generic openers.
 */
export function getTemplateExamples(details: string | undefined): string[] {
  const authored = parseBullets(sectionBody(details, EXAMPLE_PROMPTS_SECTION_TITLE) ?? '')
  const examples = (authored.length > 0 ? authored : getTemplateUseCases(details)).slice(0, 3)
  for (const generic of GENERIC_EXAMPLES) {
    if (examples.length >= 3) break
    examples.push(generic)
  }
  return examples
}

/**
 * Split the index's `details` markdown into its `##` sections so each can be
 * rendered under its own heading instead of one undifferentiated blob.
 *
 * Everything before the first `##` is dropped: it's an H1 of the agent name
 * followed by the description, both already in the page header.
 */
/**
 * Headings whose body inventories what ships with the template rather than
 * prose. Two names for one thing: the bulk-imported agents call it `Files`
 * (and all list the same three scaffolding files), while the hand-written ones
 * call it `What's inside` and list their real skills. No agent has both.
 */
export const INVENTORY_SECTION_TITLES = new Set(['Files', "What's inside"])

/** The one heading both render under. */
export const INVENTORY_SECTION_LABEL = "What's Inside"

export interface TemplateInventoryItem {
  name: string
  description: string
}

const CODE_EXTENSIONS =
  /\.(sql|py|ts|tsx|js|jsx|mjs|cjs|sh|bash|zsh|rb|go|rs|java|php|css|html|db|sqlite3?)$/i

/** Directories and files whose blurb says they hold code, for the many entries
 *  that are paths with no extension (`nutrition/`, `artifacts/dashboard/`). */
const CODE_BLURB = /\b(script|scripts|code|database|schema|sql|dashboard|python|bun|node)\b/i

/** Just the last path segment — `.claude/skills/log-meal/` reads as
 *  `log-meal`. The full path stays available for the tooltip. */
export function inventoryLabel(name: string): string {
  const trimmed = name.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Which glyph an inventory entry gets: a book for skills, a code mark for
 * anything executable or data-backed, and a plain file for the rest.
 */
export function inventoryIcon(item: TemplateInventoryItem): LucideIcon {
  if (/(^|\/)\.?claude\/skills\//.test(item.name) || /(^|\/)skills\//.test(item.name)) {
    return BookOpen
  }
  if (CODE_EXTENSIONS.test(item.name) || CODE_BLURB.test(item.description)) return Code2
  return FileText
}

/**
 * An inventory list, whose lines read `` - `NAME` — what it's for ``. A line
 * may name more than one path (`` `a.db` + `a.sql` — database and schema ``),
 * so every backticked token becomes its own item sharing the trailing blurb.
 * Returns empty when no line matches, which is the caller's cue to render the
 * section as ordinary markdown instead.
 */
export function parseInventory(body: string): TemplateInventoryItem[] {
  const items: TemplateInventoryItem[] = []
  for (const line of body.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (!bullet) continue
    const names = [...bullet[1].matchAll(/`([^`]+)`/g)]
    if (names.length === 0) continue
    const last = names[names.length - 1]
    const description = bullet[1]
      .slice((last.index ?? 0) + last[0].length)
      .replace(/^[\s—–\-+·:]+/, '')
      .trim()
      .replace(/\.$/, '')
    for (const match of names) {
      const name = match[1].trim()
      if (name) items.push({ name, description })
    }
  }
  return items
}

export function parseTemplateDetails(details: string): TemplateDetailSection[] {
  const sections: TemplateDetailSection[] = []
  for (const chunk of details.split(/^##[ \t]+/m).slice(1)) {
    const break_ = chunk.indexOf('\n')
    const title = (break_ === -1 ? chunk : chunk.slice(0, break_)).trim()
    const body = (break_ === -1 ? '' : chunk.slice(break_ + 1)).trim()
    if (!title || !body || SKIPPED_DETAIL_SECTIONS.has(title)) continue
    sections.push({ title, body })
  }
  return sections
}
