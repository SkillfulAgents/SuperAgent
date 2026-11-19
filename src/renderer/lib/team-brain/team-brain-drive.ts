import type { FolderEntry } from '@renderer/hooks/use-folder-entries'
import { OPENED_SHARE, TREE_BUDGET } from './team-brain-budget'
import type { TeamBrainNode } from './team-brain-structure'

/** A drive's listed folders, by path; the drive's top is `''`. */
export type DriveListing = ReadonlyMap<string, readonly FolderEntry[]>

const shown = (entry: FolderEntry) => !entry.name.startsWith('.')

/**
 * The folders the tree still needs listed: level by level from the top, and from each opened folder, until a level
 * holds more than the budget. That last level is listed too, since its folders' contents are the counts and previews
 * at the tree's edge. A folder too big for the budget on its own is listed but not gone into, as the tree keeps it folded.
 */
export function foldersToList(listed: DriveListing, expanded: ReadonlySet<string>, budget = TREE_BUDGET): string[] {
  const need: string[] = []
  const walk = (start: string, room: number) => {
    let level = [start]
    while (level.length > 0) {
      const missing = level.filter((path) => !listed.has(path))
      if (missing.length > 0) return void need.push(...missing)
      const next = level.flatMap((path) => listed.get(path)!.filter(shown)).filter((entry) => entry.type === 'file' || !oversized(listed, entry.path, room))
      if (next.length > room) return
      level = next.filter((entry) => entry.type === 'directory').map((entry) => entry.path)
    }
  }
  walk('', budget)
  for (const path of expanded) walk(path, Math.round(budget * OPENED_SHARE))
  return [...new Set(need)]
}

const oversized = (listed: DriveListing, path: string, room: number) => (listed.get(path)?.filter(shown).length ?? 0) > room

/**
 * The team record: the agent's own files rather than the team's knowledge. `_brain` holds its rules, sources,
 * changelog, archive and sync summaries, and the agents' `INDEX.md` stays at the top because every mounted drive's root
 * `INDEX.md` goes into its agents' prompts. A brain from before the archive moved under `_brain` still has `_archive`.
 */
export const TEAM_RECORD_FOLDER = '_brain'
export const TEAM_RECORD_INDEX = 'INDEX.md'
const LEGACY_ARCHIVE = '_archive'
const SYNCS = `${TEAM_RECORD_FOLDER}/syncs`

/** The tree's switches for the team record: how the brain runs, and what it removed. */
export const RECORD_GROUPS = ['about', 'archive'] as const
export type RecordGroup = (typeof RECORD_GROUPS)[number]

/** The top-level folders the record's groups show, which draw back into the middle when the last group goes off. */
export const RECORD_SECTIONS: readonly string[] = [TEAM_RECORD_FOLDER, LEGACY_ARCHIVE]

/**
 * Where an entry at the drive's top or in `_brain` belongs, by where it sits rather than what it is called: a group,
 * `syncs` for the sync summaries (the page lists them, so the tree never does), or `team` for the team's knowledge.
 */
export function recordPlaceOf(path: string): RecordGroup | 'syncs' | 'team' {
  if (path === TEAM_RECORD_INDEX || path === TEAM_RECORD_FOLDER) return 'about'
  if (path === LEGACY_ARCHIVE || path === `${TEAM_RECORD_FOLDER}/archive`) return 'archive'
  if (path === SYNCS) return 'syncs'
  return path.startsWith(`${TEAM_RECORD_FOLDER}/`) ? 'about' : 'team'
}

/** Whether a path is the record's or under it, so the tree lists it ahead of being shown. Sync summaries never are. */
export const inRecord = (path: string) =>
  [TEAM_RECORD_FOLDER, LEGACY_ARCHIVE].some((top) => path === top || path.startsWith(`${top}/`)) && path !== SYNCS && !path.startsWith(`${SYNCS}/`)

/** The groups with something in them: from the drive's top, and from `_brain` once it is listed. */
export function presentRecordGroups(listed: DriveListing): ReadonlySet<RecordGroup> {
  const entries = [...(listed.get('') ?? []), ...(listed.get(TEAM_RECORD_FOLDER) ?? [])].filter(shown)
  const present = new Set<RecordGroup>()
  for (const entry of entries) {
    // `_brain` itself is a container: what is in it decides which groups it holds.
    if (entry.path === TEAM_RECORD_FOLDER) continue
    const place = recordPlaceOf(entry.path)
    if (place === 'about' || place === 'archive') present.add(place)
  }
  return present
}

/**
 * The listing with only the record's groups that are on, so the tree shows and lists those alone, and never the sync
 * summaries. With none on it is the team's knowledge alone. Until `_brain` is listed it stays while a group is on, so it gets listed.
 */
export function withRecordGroups(listed: DriveListing, on: ReadonlySet<RecordGroup>): DriveListing {
  const top = listed.get('')
  if (!top) return listed
  const brain = listed.get(TEAM_RECORD_FOLDER)
  const keep = (entry: FolderEntry) => {
    const place = recordPlaceOf(entry.path)
    // A hidden file in `_brain` is no part of it, so it never holds `_brain` in the tree on its own.
    return place === 'team' || (place !== 'syncs' && shown(entry) && on.has(place))
  }
  const keptBrain = brain?.filter(keep)
  const next = new Map(listed)
  next.set('', top.filter((entry) => (entry.path === TEAM_RECORD_FOLDER ? (keptBrain ? keptBrain.length > 0 : on.size > 0) : keep(entry))))
  if (keptBrain) next.set(TEAM_RECORD_FOLDER, keptBrain)
  return next
}

/**
 * The brain's two front pages at the drive's top, which the tree's middle opens instead of showing them as pages:
 * `README.md` for people, and `INDEX.md` for agents (listed only while the team record shows).
 */
export function splitFrontPages(drive: readonly TeamBrainNode[]): { front: TeamBrainNode | undefined; index: TeamBrainNode | undefined; rest: TeamBrainNode[] } {
  const top = (id: string) => drive.find((node) => node.kind === 'file' && node.id === id)
  const front = top('README.md')
  const index = top('INDEX.md')
  return { front, index, rest: drive.filter((node) => node !== front && node !== index) }
}

/** The listed part of the drive as the tree's nodes. A folder not listed yet has no `children`. */
export function driveTree(listed: DriveListing, now: number, path = ''): TeamBrainNode[] {
  return (listed.get(path) ?? []).filter(shown).map((entry) =>
    entry.type === 'directory'
      ? { id: entry.path, name: entry.name, kind: 'folder', sources: [], children: listed.has(entry.path) ? driveTree(listed, now, entry.path) : undefined }
      : { id: entry.path, name: entry.name, kind: 'file', sources: [], updatedMinutesAgo: entry.mtimeMs ? Math.max(0, Math.round((now - entry.mtimeMs) / 60_000)) : undefined },
  )
}
