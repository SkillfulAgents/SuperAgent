import { apiFetch } from '@renderer/lib/api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface Bookmark {
  name: string
  link?: string
  file?: string
}

export function useBookmarks(agentSlug: string | null) {
  return useQuery<Bookmark[]>({
    queryKey: ['bookmarks', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/bookmarks`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: 30_000,
  })
}

export function useUpdateBookmarks(agentSlug: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (bookmarks: Bookmark[]) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/bookmarks`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookmarks),
      })
      if (!res.ok) throw new Error('Failed to update bookmarks')
      return res.json() as Promise<Bookmark[]>
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['bookmarks', agentSlug], data)
    },
  })
}
