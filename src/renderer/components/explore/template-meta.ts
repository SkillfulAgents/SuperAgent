import {
  Apple,
  BadgeDollarSign,
  Bot,
  BookOpen,
  Calculator,
  CalendarCheck,
  Code2,
  FileText,
  House,
  Inbox,
  LifeBuoy,
  ListChecks,
  Mail,
  Megaphone,
  MessagesSquare,
  Mic,
  PenLine,
  Plane,
  Presentation,
  Search,
  SearchCheck,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Target,
  UserSearch,
  Video,
  WandSparkles,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * Presentation helpers for marketplace templates.
 *
 * Everything here maps or formats data the skillset repo's `index.json`
 * actually provides — name, description, category, icon, tags, connections,
 * developer, and the long-form details markdown. Nothing is invented: run
 * cost and suggested models used to be mocked here and were removed rather
 * than shown as fact.
 */

// ── Icons ────────────────────────────────────────────────────────────────────

/**
 * The kebab-case icon names the public skillset uses, mapped to their lucide
 * components. Listed explicitly rather than resolved dynamically so the bundle
 * only carries the icons we actually render.
 */
const ICONS_BY_NAME: Record<string, LucideIcon> = {
  apple: Apple,
  'badge-dollar-sign': BadgeDollarSign,
  'book-open': BookOpen,
  calculator: Calculator,
  'calendar-check': CalendarCheck,
  'code-2': Code2,
  house: House,
  inbox: Inbox,
  'life-buoy': LifeBuoy,
  'list-checks': ListChecks,
  mail: Mail,
  megaphone: Megaphone,
  'messages-square': MessagesSquare,
  mic: Mic,
  'pen-line': PenLine,
  plane: Plane,
  presentation: Presentation,
  search: Search,
  'search-check': SearchCheck,
  'shield-check': ShieldCheck,
  'shopping-cart': ShoppingCart,
  sparkles: Sparkles,
  target: Target,
  'user-search': UserSearch,
  video: Video,
  'wand-sparkles': WandSparkles,
  workflow: Workflow,
}

/** Anything the index names but we don't bundle falls back to a generic glyph. */
const FALLBACK_ICONS: LucideIcon[] = [Bot, Sparkles, Workflow, Zap]

export function getTemplateIcon(template: ApiDiscoverableAgent): LucideIcon {
  const named = template.icon ? ICONS_BY_NAME[template.icon] : undefined
  if (named) return named
  return FALLBACK_ICONS[hashString(template.name) % FALLBACK_ICONS.length]
}

// ── Accent colors ────────────────────────────────────────────────────────────

/** Palette keys for the icon glyph (see ACCENT_CLASSES). */
export type AccentColor =
  | 'orange'
  | 'salmon'
  | 'yellow'
  | 'green'
  | 'teal'
  | 'blue'
  | 'violet'
  | 'pink'

/**
 * Glyph colors, from the reference palette's hues extended to eight. Built on
 * Tailwind's 600 ramp rather than raw hex so the set stays balanced and the
 * dark-mode variants come along for free.
 *
 * 600 is deliberate: the 500s carry slightly more chroma but drop under 3:1
 * against the grey tile for yellow (1.97), green (2.09), teal (2.28) and
 * orange (2.57), which reads as washed out rather than vivid. 600 is the most
 * saturated step that still clears the 3:1 graphics threshold everywhere.
 * Class strings are written out in full so Tailwind's scanner keeps them.
 */
const ACCENT_CLASSES: Record<AccentColor, string> = {
  orange: 'text-orange-600 dark:text-orange-400',
  salmon: 'text-rose-600 dark:text-rose-400',
  yellow: 'text-amber-600 dark:text-amber-400',
  green: 'text-green-600 dark:text-green-400',
  teal: 'text-teal-600 dark:text-teal-400',
  blue: 'text-blue-600 dark:text-blue-400',
  violet: 'text-violet-600 dark:text-violet-400',
  pink: 'text-fuchsia-600 dark:text-fuchsia-400',
}

/**
 * The same hues as a wash for the hero band: a strong corner fading to nothing
 * so the grey underneath still reads as the base. Written out in full so
 * Tailwind's scanner keeps them.
 */
const ACCENT_GRADIENTS: Record<AccentColor, string> = {
  orange: 'from-orange-400/30 via-orange-300/10 to-transparent',
  salmon: 'from-rose-400/30 via-rose-300/10 to-transparent',
  yellow: 'from-amber-400/30 via-amber-300/10 to-transparent',
  green: 'from-green-400/30 via-green-300/10 to-transparent',
  teal: 'from-teal-400/30 via-teal-300/10 to-transparent',
  blue: 'from-blue-400/30 via-blue-300/10 to-transparent',
  violet: 'from-violet-400/30 via-violet-300/10 to-transparent',
  pink: 'from-fuchsia-400/30 via-fuchsia-300/10 to-transparent',
}

const ACCENT_COLOR_KEYS = Object.keys(ACCENT_CLASSES) as AccentColor[]

function accentKey(name: string): AccentColor {
  return ACCENT_COLOR_KEYS[hashString(name) % ACCENT_COLOR_KEYS.length]
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

/** The glyph color for a template, keyed off its name so a given template
 *  always draws the same color. */
export function getTemplateAccent(name: string): string {
  return ACCENT_CLASSES[accentKey(name)]
}

/** The hero wash in the template's own accent hue — same key as the glyph. */
export function getTemplateGradient(name: string): string {
  return ACCENT_GRADIENTS[accentKey(name)]
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
 * Templates authored by us rather than contributed — the 8 hand-built agents
 * that predate the bulk Bot Directory import, and the only ones shipping real
 * `.claude/skills/` directories. It's a first-party signal from the index, not
 * editorial curation: the index has no `featured` flag.
 */
export const FEATURED_SECTION_LABEL = 'Featured'

const FIRST_PARTY_DEVELOPER = 'SkillfulAgents'

export function isFeaturedTemplate(template: ApiDiscoverableAgent): boolean {
  return template.developer?.name === FIRST_PARTY_DEVELOPER
}

// ── Connections ──────────────────────────────────────────────────────────────

/**
 * Slugs the index references that have no matching SVG in
 * public/service-icons. They render with the generic fallback glyph rather
 * than a stand-in logo — a wrong brand mark is worse than none.
 */
const MISSING_CONNECTION_ICONS = new Set(['granola', 'microsoft_teams'])

/** The service-icon slug for a connection, or undefined when we have no logo. */
export function connectionIconSlug(slug: string): string | undefined {
  return MISSING_CONNECTION_ICONS.has(slug) ? undefined : slug
}

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
