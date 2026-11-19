import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { describeWorkspaceFile, type WorkspaceFile } from '@renderer/lib/workspace-file'

/** How often the open file is checked. Each check is one HEAD, which stats the file and opens nothing. */
export const CHANGE_CHECK_INTERVAL_MS = 2_000

const revisionKey = (apiPath: string | null) => ['file-revision', apiPath]

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
    queryKey: revisionKey(apiPath),
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

/**
 * Checks a file the moment the agent delivers it, instead of at the next
 * interval: a delivery says "look at this now". Each delivery is acted on
 * once, by its tool call's id. It asks only when the file is the one the
 * drawer is showing, and the check reloads nothing that has not changed.
 */
export function useCheckDeliveredFiles(deliveries: readonly { id: string; filePath: string }[], agentSlug: string): void {
  const queryClient = useQueryClient()
  const checked = useRef(new Set<string>())
  useEffect(() => {
    for (const { id, filePath } of deliveries) {
      if (checked.current.has(id)) continue
      checked.current.add(id)
      void queryClient.invalidateQueries({ queryKey: revisionKey(describeWorkspaceFile(filePath, agentSlug).apiPath), type: 'active' })
    }
  }, [deliveries, agentSlug, queryClient])
}
