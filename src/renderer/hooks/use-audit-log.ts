import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type { AuditLogEntry } from '@shared/lib/db/schema'

export interface AuditLogPage {
  entries: AuditLogEntry[]
  total: number
  limit: number
  offset: number
}

export interface AuditLogFilters {
  eventMap: Record<string, readonly string[]>
  users: Array<{ id: string; name: string; email: string }>
}

export function useAuditLog(params: {
  object?: string
  action?: string
  userId?: string
  limit: number
  offset: number
}) {
  return useQuery<AuditLogPage>({
    queryKey: ['audit-log', params],
    queryFn: async () => {
      const searchParams = new URLSearchParams()
      if (params.object) searchParams.set('object', params.object)
      if (params.action) searchParams.set('action', params.action)
      if (params.userId) searchParams.set('userId', params.userId)
      searchParams.set('limit', String(params.limit))
      searchParams.set('offset', String(params.offset))
      const res = await apiFetch(`/api/audit-log?${searchParams}`)
      if (!res.ok) throw new Error('Failed to fetch audit log')
      return res.json()
    },
  })
}

export function useAuditLogFilters() {
  return useQuery<AuditLogFilters>({
    queryKey: ['audit-log-filters'],
    queryFn: async () => {
      const res = await apiFetch('/api/audit-log/filters')
      if (!res.ok) throw new Error('Failed to fetch audit log filters')
      return res.json()
    },
    staleTime: 60_000,
  })
}
