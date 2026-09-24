import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { providerUsageSchema } from '@shared/lib/llm-provider/usage-schema'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'

export function supportsUsage(connection: Pick<ConnectionInfo, 'supportsUsage'>) {
  return connection.supportsUsage === true
}
export function useProviderUsage(connection: ConnectionInfo) {
  const { user } = useUser()
  const enabled = supportsUsage(connection) && connection.isConfigured && (!connection.userId || connection.userId === user?.id)
  const query = useQuery({
    queryKey: ['llm-provider-usage', user?.id ?? null, connection.id, connection.isConfigured],
    queryFn: async () => {
      const response = await apiFetch(`/api/llm-connections/${encodeURIComponent(connection.id)}/usage`)
      if (!response.ok) throw new Error('Could not load provider usage')
      return providerUsageSchema.parse(await response.json())
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  })
  return { ...query, data: enabled ? query.data : undefined }
}
