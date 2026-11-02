import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createdVolumeFolderSchema, volumeFoldersSchema, type VolumeFolders } from '@shared/lib/volumes/volume-folders-schema'
import { apiFetch } from '@renderer/lib/api'
import { FolderEntriesError } from '@renderer/hooks/use-folder-entries'
import type { VolumeType } from '@shared/lib/types/mount'

const foldersKey = (type: VolumeType, query: Record<string, string>) => [`${type}-folders`, query]

/** All sources browse through the type registry and return the same folder shape. */
export function useVolumeFolders(source: { type: VolumeType; label: string }, query: Record<string, string>, enabled: boolean) {
  return useQuery({
    queryKey: foldersKey(source.type, query),
    enabled,
    retry: false,
    queryFn: async () => {
      const response = await apiFetch(`/api/volume-types/${source.type}/folders?${new URLSearchParams(query)}`)
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new Error(error?.error ?? `Could not load ${source.label} folders`)
      }
      return volumeFoldersSchema.parse(await response.json())
    },
  })
}

/** Makes a folder inside the one `query` browses, and adds it to that folder's listing. */
export function useCreateVolumeFolder(source: { type: VolumeType; label: string }) {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ query, name }: { query: Record<string, string>; name: string }) => {
      const response = await apiFetch(`/api/volume-types/${source.type}/folders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...query, name }),
      })
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new FolderEntriesError(error?.error ?? 'Could not create it. Please try again.', response.status)
      }
      return createdVolumeFolderSchema.parse(await response.json()).folder
    },
    // A create whose answer was lost may still have been made: read the listing again so it can be picked.
    // A refusal (4xx) made nothing, so the listing stays as it is.
    onError: (error, { query }) => {
      if (!(error instanceof FolderEntriesError && error.status < 500)) void queryClient.invalidateQueries({ queryKey: foldersKey(source.type, query) })
    },
    onSuccess: async (folder, { query }) => {
      // A listing read before the folder existed must not land after it and drop it.
      await queryClient.cancelQueries({ queryKey: foldersKey(source.type, query) })
      queryClient.setQueryData<VolumeFolders>(foldersKey(source.type, query), data =>
        data && !data.folders.some(known => known.id === folder.id) ? { folders: [folder, ...data.folders] } : data)
    },
  })
}
