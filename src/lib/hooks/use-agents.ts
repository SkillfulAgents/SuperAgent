import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Agent } from '@/lib/db/schema'
import type { ContainerStatus } from '@/lib/container/types'

// API response type includes Docker-derived fields
export interface AgentWithStatus extends Agent {
  status: ContainerStatus
  containerPort: number | null
}

export function useAgents() {
  return useQuery<AgentWithStatus[]>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
    refetchInterval: 5000, // Poll for status changes
  })
}

export function useAgent(id: string | null) {
  return useQuery<AgentWithStatus>({
    queryKey: ['agents', id],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${id}`)
      if (!res.ok) throw new Error('Failed to fetch agent')
      return res.json()
    },
    enabled: !!id,
    refetchInterval: 5000, // Poll for status changes
  })
}

export function useCreateAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: { name: string }) => {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create agent')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useDeleteAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/agents/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete agent')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
}

export function useStartAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/agents/${id}/start`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to start agent')
      return res.json()
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', id] })
    },
  })
}

export function useStopAgent() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/agents/${id}/stop`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to stop agent')
      return res.json()
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents', id] })
    },
  })
}
