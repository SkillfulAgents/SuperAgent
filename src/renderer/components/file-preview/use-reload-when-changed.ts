import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useFilePreview } from '@renderer/context/file-preview-context'
import type { WorkspaceFile } from '@renderer/lib/workspace-file'

/** How often the open file is checked. Each check is one HEAD, which stats the file and opens nothing. */
export const CHANGE_CHECK_INTERVAL_MS = 2_000

/**
 * Reloads the drawer's open file when it changes, whoever changed it: the
 * agent, a job it left running, or the user in another app. While the window is
 * visible it asks the file route for the file's ETag and hands each answer to
 * the tab, which reloads only when the answer differs from the one it loaded.
 * A file that is gone counts as changed, so its old text does not stay up.
 * A server that sends no ETag (an older cloud workspace) gets no reloads.
 */
export function useReloadWhenChanged(file: WorkspaceFile | null): void {
  const { reloadIfChanged } = useFilePreview()
  const apiPath = file?.reloadsInPlace ? file.apiPath : null
  const { data: revision } = useQuery({
    queryKey: ['file-revision', apiPath],
    queryFn: async () => {
      const res = await apiFetch(apiPath as string, { method: 'HEAD' })
      return res.status === 404 ? 'missing' : res.headers.get('etag')
    },
    enabled: apiPath !== null,
    refetchInterval: CHANGE_CHECK_INTERVAL_MS,
    retry: false,
  })

  const path = file?.path
  const agentSlug = file?.agentSlug
  useEffect(() => {
    if (apiPath && path && agentSlug && revision) reloadIfChanged(path, agentSlug, revision)
  }, [apiPath, path, agentSlug, revision, reloadIfChanged])
}
