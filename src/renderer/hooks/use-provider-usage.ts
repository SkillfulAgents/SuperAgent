import { useQueries, useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { providerUsageSchema } from '@shared/lib/llm-provider/usage-schema'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'

export function supportsUsage(connection: Pick<ConnectionInfo, 'supportsUsage'>) {
  return connection.supportsUsage === true
}
function usageEnabled(connection: ConnectionInfo, userId: string | null) {
  return supportsUsage(connection) && connection.isConfigured && (!connection.userId || connection.userId === userId)
}
function providerUsageQuery(connection: ConnectionInfo, userId: string | null, refreshCredentials = false) {
  return {
    queryKey: ['llm-provider-usage', connection.id, userId, connection.isConfigured, refreshCredentials],
    queryFn: async () => {
      const response = await apiFetch(`/api/llm-connections/${encodeURIComponent(connection.id)}/usage${refreshCredentials ? '?refreshCredentials=1' : ''}`)
      if (!response.ok) throw new Error('Could not load provider usage')
      return providerUsageSchema.parse(await response.json())
    },
    enabled: usageEnabled(connection, userId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  } as const
}
export function useProviderUsage(connection: ConnectionInfo) {
  const { user } = useUser()
  const userId = user?.id ?? null
  const enabled = usageEnabled(connection, userId)
  const query = useQuery(providerUsageQuery(connection, userId))
  return { data: enabled ? query.data : undefined, isError: query.isError, isPending: enabled && query.isPending }
}
export function useProviderUsages(connections: readonly ConnectionInfo[], options: { refreshCredentials?: boolean } = {}) {
  const { user } = useUser()
  const userId = user?.id ?? null
  const queries = useQueries({ queries: connections.map(connection => providerUsageQuery(connection, userId, options.refreshCredentials)) })
  return queries.map((query, index) => {
    const enabled = usageEnabled(connections[index], userId)
    return { data: enabled ? query.data : undefined, isError: query.isError, isPending: enabled && query.isPending }
  })
}
