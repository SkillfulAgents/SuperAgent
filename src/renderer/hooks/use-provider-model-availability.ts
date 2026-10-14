import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { modelAvailabilitySchema } from '@shared/lib/llm-provider/model-availability-schema'
import type { ModelDefinition } from '@shared/lib/llm-provider/model-catalog-schema'

/** Model policy comes from the selected connection's provider. */
export function useProviderModelAvailability(connection: Pick<ConnectionInfo, 'id' | 'isConfigured' | 'supportsModelAvailability' | 'modelAvailabilityRevision'> | undefined) {
  const id = connection?.id
  const query = useQuery({
    queryKey: ['provider-model-availability', id, connection?.modelAvailabilityRevision ?? null],
    enabled: !!id && connection?.isConfigured === true && connection.supportsModelAvailability === true,
    queryFn: async () => {
      const response = await apiFetch(`/api/llm-connections/${encodeURIComponent(id!)}/model-availability`)
      if (!response.ok) throw new Error('Could not load model availability')
      const data: unknown = await response.json()
      return data === null ? null : modelAvailabilitySchema.parse(data)
    },
    staleTime: 30_000,
  })
  const availability = connection?.isConfigured && connection.supportsModelAvailability ? query.data ?? null : null
  return useMemo(() => {
    const unavailable = new Set(availability?.unavailableModelIds ?? [])
    const isUnavailable = (model: ModelDefinition) => unavailable.has(model.id)
    return {
      availability,
      updatedAt: query.dataUpdatedAt,
      isUnavailable,
      refresh: query.refetch,
    }
  }, [availability, query.dataUpdatedAt, query.refetch])
}
