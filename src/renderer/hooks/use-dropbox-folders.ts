import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { dropboxFoldersSchema } from '@shared/lib/volumes/dropbox-schema'

export function useDropboxFolders(accountId: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['dropbox-folders', accountId, path],
    enabled: enabled && !!accountId,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams({ accountId, path })
      const response = await apiFetch(`/api/volume-definitions/dropbox/folders?${params}`)
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new Error(error?.error ?? 'Could not load Dropbox folders')
      }
      return dropboxFoldersSchema.parse(await response.json())
    },
  })
}
