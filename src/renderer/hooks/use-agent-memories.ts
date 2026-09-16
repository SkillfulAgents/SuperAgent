import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { AgentMemoryDocument, AgentMemoryEntry } from '@shared/lib/types/memory'

const base = (slug: string) => `/api/agents/${encodeURIComponent(slug)}/memories`
const listKey = (slug: string | null) => ['agent-memories', slug]
const docKey = (slug: string, path: string | null) => ['agent-memory', slug, path]

async function responseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(typeof body?.error === 'string' ? body.error : 'Unable to access agent memories')
  }
  return res.json()
}

export function useAgentMemories(slug: string | null) {
  return useQuery({
    queryKey: listKey(slug),
    queryFn: async () => (await responseJson<{ memories: AgentMemoryEntry[] }>(await apiFetch(base(slug!)))).memories,
    enabled: !!slug,
  })
}

export function useAgentMemory(slug: string, path: string | null) {
  return useQuery({
    queryKey: docKey(slug, path),
    queryFn: async () => responseJson<AgentMemoryDocument>(await apiFetch(`${base(slug)}/content?path=${encodeURIComponent(path!)}`)),
    enabled: path !== null,
  })
}

export function useSaveAgentMemory(slug: string) {
  const client = useQueryClient()
  return useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (input: { path: string; content: string; revision: string }) =>
      responseJson<AgentMemoryDocument>(await apiFetch(`${base(slug)}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })),
    onSuccess: doc => {
      client.setQueryData(docKey(slug, doc.path), doc)
      void client.invalidateQueries({ queryKey: listKey(slug) })
    },
  })
}
