import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiAgent } from '@/lib/types/api'

// Re-export for convenience
export type { ApiAgent }

export function useAgents() {
  return useQuery<ApiAgent[]>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
    refetchInterval: 5000, // Poll for status changes
  })
}

export function useAgent(slug: string | null) {
  return useQuery<ApiAgent>({
    queryKey: ['agents', slug],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${slug}`)
      if (!res.ok) throw new Error('Failed to fetch agent')
      return res.json()
    },
    enabled: !!slug,
    refetchInterval: 5000, // Poll for status changes
  })
}

export function useCreateAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create agent')
      return res.json() as Promise<ApiAgent>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await fetch(`/api/agents/${slug}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete agent')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useUpdateAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      slug,
      name,
      description,
      instructions,
    }: {
      slug: string
      name?: string
      description?: string
      instructions?: string
    }) => {
      const res = await fetch(`/api/agents/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, instructions }),
      })
      if (!res.ok) throw new Error('Failed to update agent')
      return res.json() as Promise<ApiAgent>
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', variables.slug] })
    },
  })
}

export function useStartAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await fetch(`/api/agents/${slug}/start`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to start agent')
      return res.json()
    },
    onSuccess: (_, slug) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', slug] })
    },
  })
}

export function useStopAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (slug: string) => {
      const res = await fetch(`/api/agents/${slug}/stop`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to stop agent')
      return res.json()
    },
    onSuccess: (_, slug) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', slug] })
    },
  })
}
