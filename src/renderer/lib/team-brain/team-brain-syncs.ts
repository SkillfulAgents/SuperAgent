import { splitFrontmatter } from '@renderer/lib/markdown-frontmatter'

/**
 * What one sync did, as the upkeep run writes it to `_brain/syncs/<time>.md` in the drive: a header marked
 * `type: team-brain-sync` with when it ran, its session, the apps it read and how many pages it added and updated, then `## Highlights` (a `###` title and a few
 * sentences each), `## Changes` (a line each) and `## Needs you`, a line each under `### Blocked` and `### To decide`. Each part is kept as the Markdown
 * it was written in. Pages are linked relative to the summary, `[Acme](../../customers/acme.md)`.
 */
export interface TeamBrainSync {
  id: string
  at: string
  session: string | null
  /** Toolkit slugs of the apps it found something new in. */
  sources: string[]
  added: number
  updated: number
  highlights: { title: string; body: string }[]
  changes: string
  /**
   * What needs a person, each line with what to do. Blocked: what kept the run from covering part of the brain, and
   * what it skipped. To decide: calls left to a person, each with what it filed meanwhile. Lines under no heading are to decide.
   */
  needsYou: { blocked: string; toDecide: string }
}

/** The header line that marks a drive file as a sync summary. */
export const SYNC_TYPE = 'team-brain-sync'
const MOST_HIGHLIGHTS = 5
const MOST_SOURCES = 20

/** A sync summary, or null for any other file: the folder is the agent's and people's to write in, so a file counts only with the mark and a time. */
export function parseSyncSummary(id: string, raw: string): TeamBrainSync | null {
  // Files written or edited on Windows end their lines with CRLF.
  const text = raw.replace(/\r\n?/g, '\n')
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) return null
  const fields = new Map(frontmatter.split('\n').map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]))
  const at = fields.get('at') ?? ''
  // A time with no offset would read differently for each person, so it has to carry one.
  if (fields.get('type') !== SYNC_TYPE || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at) || Number.isNaN(Date.parse(at))) return null
  // A part's heading line, and what follows it as written: nothing when the heading ends the file.
  const head = (part: string) => part.split('\n', 1)[0].trim()
  const rest = (part: string) => (part.includes('\n') ? part.slice(part.indexOf('\n') + 1).trimEnd() : '')
  const joined = (parts: string[]) => parts.filter(Boolean).join('\n\n')
  const sections = new Map<string, string>()
  for (const part of body.split(/^## /m).slice(1)) sections.set(head(part).toLowerCase(), rest(part))
  // A count the agent got wrong ("two", -1, Infinity) reads as none.
  const count = (name: string) => {
    const n = Math.trunc(Number(fields.get(name)))
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const [loose, ...groups] = (sections.get('needs you') ?? '').split(/^### /m)
  const group = (name: string) => groups.filter((part) => head(part).toLowerCase() === name).map(rest)
  const highlights = (sections.get('highlights') ?? '')
    .split(/^### /m)
    .slice(1)
    .slice(0, MOST_HIGHLIGHTS)
    .map((part) => ({ title: head(part), body: rest(part) }))
  return {
    id,
    at,
    // Only an id can open the run: a placeholder or note the agent wrote instead leaves the title unlinked.
    session: /^[\w-]+$/.test(fields.get('session') ?? '') ? (fields.get('session') ?? null) : null,
    // Each is an app's key and draws its icon, so only key-shaped ones, and no more than any team connects.
    sources: [...new Set((fields.get('sources') ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter((s) => /^[\w-]{1,64}$/.test(s)))].slice(0, MOST_SOURCES),
    added: count('added'),
    updated: count('updated'),
    highlights,
    changes: sections.get('changes') ?? '',
    needsYou: { blocked: joined(group('blocked')), toDecide: joined([loose.trimEnd(), ...group('to decide')]) },
  }
}

/** The summaries to read: the newest written, by when each file last changed, so how the agent names them doesn't matter. */
export function latestSummaryFiles<T extends { name: string; type: string; mtimeMs?: number }>(entries: readonly T[], shown: number): T[] {
  return entries
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.md'))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || b.name.localeCompare(a.name))
    .slice(0, shown)
}

export type SummaryLink = { page: string } | 'web' | 'text'

/**
 * Where a link in a summary leads. Links are the brain's own, Markdown and relative to the summary:
 * `../../customers/acme.md` is a page in the drive. A link with a scheme is left to the shared link and its policy.
 * A link that leads out of the drive, or to nothing, reads as its words.
 */
export function summaryLink(href: string | undefined, from: string): SummaryLink {
  const target = (href ?? '').split('#')[0]
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return 'web'
  const page = target ? drivePath(from, target) : null
  return page ? { page } : 'text'
}

/** Where a relative link from `from` lands in the drive, or null when it leads out of it. A leading `/` is the drive's top. */
function drivePath(from: string, href: string): string | null {
  const path = href.startsWith('/') ? [] : from.split('/').filter(Boolean)
  for (const raw of href.split('/')) {
    // Decoded first, so `%2e%2e` is the `..` it stands for.
    const segment = decodeSegment(raw)
    if (segment === '' || segment === '.') continue
    if (segment !== '..') path.push(segment)
    else if (!path.pop()) return null
  }
  return path.length > 0 ? path.join('/') : null
}

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
