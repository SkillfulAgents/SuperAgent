import {
  Apple,
  BadgeDollarSign,
  Bot,
  BookOpen,
  Calculator,
  CalendarCheck,
  Code2,
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
 * Name, description, category, icon, tags, connections, developer, and the
 * long-form details markdown are REAL — they come from the skillset repo's
 * `index.json`. What the index still doesn't carry (run cost, suggested
 * models, security review, starter prompts) is mocked at the bottom of this
 * file and clearly marked.
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

const ACCENT_COLOR_KEYS = Object.keys(ACCENT_CLASSES) as AccentColor[]

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
  return ACCENT_CLASSES[ACCENT_COLOR_KEYS[hashString(name) % ACCENT_COLOR_KEYS.length]]
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

// ── Still mocked ─────────────────────────────────────────────────────────────
// The index carries no commercial or operational metadata, so everything below
// is invented for layout purposes and marked as illustrative in the UI.

/** Estimated monthly run cost, derived from how many services a template
 *  touches — more connections means more calls, which is at least directionally
 *  honest. MOCK. */
export function getTemplateCost(template: ApiDiscoverableAgent): { min: number; max: number } {
  const connections = template.worksWith?.length ?? 0
  const base = 3 + connections * 6
  return { min: base, max: base * 2 + 4 }
}

/** $ – $$$$ tier for a monthly cost range. */
export function costTier(cost: { min: number; max: number }): number {
  const mid = (cost.min + cost.max) / 2
  if (mid < 10) return 1
  if (mid < 30) return 2
  if (mid < 60) return 3
  return 4
}

/** MOCK — the index says nothing about model fit. */
export function getSuggestedModels(): string[] {
  return ['Opus 5', 'Sonnet 5']
}
