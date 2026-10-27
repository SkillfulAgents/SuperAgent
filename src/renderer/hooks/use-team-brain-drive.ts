import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { fetchVolumeFolder, FolderEntriesError, type FolderEntry } from '@renderer/hooks/use-folder-entries'
import { driveTree, foldersToList, inRecord, presentRecordGroups, TEAM_RECORD_FOLDER, withRecordGroups, type DriveListing, type RecordGroup } from '@renderer/lib/team-brain/team-brain-drive'

/** How long a folder's listing may take before it counts as failed, and how soon a busy one is tried again. */
const LIST_TIMEOUT_MS = 20_000
const RETRY_MS = 15_000

/** A drive that was busy or slow is tried again; one that refused or is gone is not. */
const busy = (error: Error | null) => !!error && (!(error instanceof FolderEntriesError) || error.status >= 500 || error.status === 429)

const NO_GROUPS: ReadonlySet<RecordGroup> = new Set()

/** What the record holds: unknown until `_brain` is listed, and never mistaken for empty when it can't be. */
export type RecordGroupsRead = { status: 'pending' } | { status: 'failed' } | { status: 'listed'; present: ReadonlySet<RecordGroup> }

/**
 * Team Brain's drive as the tree's nodes, listed as far as the tree shows and further as folders are opened. The team
 * record shows only its groups in `record` (none by default; see `recordPlaceOf`), and `recordGroups` says which
 * groups have something in them. Each folder is its own query, under `['team-brain', brainSlug]` so a finished
 * Team Brain session refreshes it: one that fails or hangs stays folded, says so in `error`, and is tried again shortly
 * if the drive was only busy, while the rest of the tree goes on without it.
 */
export function useTeamBrainDrive(brainSlug: string, volumeId: string | undefined, expanded: ReadonlySet<string>, record: ReadonlySet<RecordGroup> = NO_GROUPS, recordLeaving = false) {
  const withRecord = record.size > 0
  const chosen = useCallback((listing: DriveListing) => withRecordGroups(listing, record), [record])
  // Every folder asked for so far. It only grows, so a listing under way is never dropped and asked for again.
  const [paths, setPaths] = useState<readonly string[]>([''])
  const combine = useCallback(
    (results: UseQueryResult<FolderEntry[]>[]) => ({
      listed: new Map(results.flatMap((r, i) => (r.data ? [[paths[i], r.data] as const] : []))) as DriveListing,
      failed: new Map(results.flatMap((r, i) => (r.error && !r.data ? [[paths[i], r.error.message] as const] : []))),
    }),
    [paths],
  )
  const { listed, failed } = useQueries({
    queries: paths.map((path) => ({
      queryKey: ['team-brain', brainSlug, 'folder', volumeId, path],
      queryFn: async () => (await fetchVolumeFolder(volumeId!, path, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })).entries,
      enabled: !!volumeId,
      staleTime: 60_000,
      retry: false,
      refetchInterval: (query: { state: { error: Error | null } }) => (busy(query.state.error) ? RETRY_MS : false),
    })),
    combine,
  })
  // A folder that failed counts as empty for finding what to list next, so its siblings' folders still list.
  const walked = useMemo(() => (failed.size ? new Map([...listed, ...[...failed.keys()].map((path) => [path, []] as const)]) : listed), [listed, failed])
  const need = useMemo(() => foldersToList(chosen(walked), expanded), [walked, chosen, expanded])
  // The record joins the tree once all it shows is listed, so it lands as one change rather than one per folder.
  // While it draws back out (`recordLeaving`) it stays if it was in, and never joins.
  const recordIn = useRef(false)
  if (!withRecord) recordIn.current = false
  else if (need.length === 0 && !recordLeaving) recordIn.current = true
  const showRecord = recordIn.current
  const visible = useMemo(() => withRecordGroups(listed, showRecord ? record : NO_GROUPS), [listed, showRecord, record])
  const hasBrain = !!listed.get('')?.some((entry) => entry.path === TEAM_RECORD_FOLDER)
  // Once the first view is in, the record's folders list behind it, so switching a group on shows it at once. `_brain`
  // always does, however wide the top is, since what it holds decides which switches there are.
  const ahead = useMemo(
    () => (!withRecord && listed.has('') && need.length === 0 ? [...(hasBrain ? [TEAM_RECORD_FOLDER] : []), ...foldersToList(walked, expanded).filter(inRecord)] : []),
    [withRecord, listed, need, walked, expanded, hasBrain],
  )
  useEffect(() => {
    const more = [...new Set([...need, ...ahead])].filter((path) => !paths.includes(path))
    if (more.length > 0) setPaths([...paths, ...more])
  }, [need, ahead, paths])
  const drive = useMemo(() => driveTree(visible, Date.now()), [visible])
  // The first view is in once nothing more can be listed for it; stays true while opened folders list after.
  const ready = useRef(false)
  if (listed.has('') && need.length === 0) ready.current = true
  // The record listed ahead says nothing when it fails: it reports once it is switched on.
  const error = [...failed].find(([path]) => withRecord || !inRecord(path))?.[1] ?? null
  // Which groups there are, once `_brain` is listed (it lists ahead of being shown).
  const brainFailed = failed.has(TEAM_RECORD_FOLDER)
  const recordGroups = useMemo<RecordGroupsRead>(() => {
    if (failed.has('')) return { status: 'failed' }
    if (!listed.has('') || (hasBrain && !listed.has(TEAM_RECORD_FOLDER) && !brainFailed)) return { status: 'pending' }
    if (hasBrain && brainFailed) return { status: 'failed' }
    return { status: 'listed', present: presentRecordGroups(listed) }
  }, [listed, failed, hasBrain, brainFailed])
  return { drive, ready: ready.current, error, recordGroups }
}
