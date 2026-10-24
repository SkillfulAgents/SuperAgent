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
 * The team record, at the drive's top: the agent's own rules, sources, changelog, archive and sync summaries in `_brain`,
 * and the index agents read. The index stays at the top because every mounted drive's root `INDEX.md` goes into its agents' prompts.
 */
export const TEAM_RECORD_FOLDER = '_brain'
export const TEAM_RECORD: ReadonlySet<string> = new Set([TEAM_RECORD_FOLDER, 'INDEX.md'])

/** The listing without the team record, so the tree neither shows nor lists it. */
export function withoutTeamRecord(listed: DriveListing): DriveListing {
  const top = listed.get('')
  return top ? new Map([...listed, ['', top.filter((entry) => !TEAM_RECORD.has(entry.path))]]) : listed
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
