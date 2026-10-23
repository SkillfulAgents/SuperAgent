import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { fetchVolumeFolder, FolderEntriesError } from '@renderer/hooks/use-folder-entries'
import { latestSummaryFiles, parseSyncSummary, type TeamBrainSync } from '@renderer/lib/team-brain/team-brain-syncs'

/** How many of the latest syncs the home page shows. */
const SHOWN = 10
/** How much of each summary is read: far more than a run writes, so a runaway file can't take the page down. */
const MOST_BYTES = 256 * 1024

/**
 * The latest sync summaries the upkeep runs wrote to `_brain/syncs/` in the drive, newest first. Under
 * `['team-brain', brainSlug]`, so a finished Team Brain session refreshes them.
 */
export function useTeamBrainSyncs(brainSlug: string, volumeId: string | undefined) {
  return useQuery<TeamBrainSync[]>({
    queryKey: ['team-brain', brainSlug, 'syncs', volumeId],
    enabled: !!volumeId,
    queryFn: async () => {
      const listing = await fetchVolumeFolder(volumeId!, '_brain/syncs').catch((error: unknown) => {
        // No `_brain/syncs/` folder yet: nothing has synced.
        if (error instanceof FolderEntriesError && error.status === 404) return null
        throw error
      })
      if (!listing) return []
      const read = await Promise.allSettled(
        latestSummaryFiles(listing.entries, SHOWN).map(async (file) => {
          const res = await apiFetch(`/api/volume-definitions/${encodeURIComponent(volumeId!)}/file?${new URLSearchParams({ path: file.path, inline: 'true' })}`, {
            headers: { Range: `bytes=0-${MOST_BYTES - 1}` },
          })
          return res.ok ? parseSyncSummary(file.path, await res.text()) : null
        }),
      )
      // One file it can't read leaves the others.
      // A summary dated past now (a wrong clock, a typo) can't be the latest run, so it is left out.
      const now = Date.now()
      return read
        .flatMap((r) => (r.status === 'fulfilled' && r.value && Date.parse(r.value.at) <= now ? [r.value] : []))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    },
  })
}
