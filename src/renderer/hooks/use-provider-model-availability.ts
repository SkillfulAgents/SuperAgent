import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { modelAvailabilitySchema } from '@shared/lib/llm-provider/model-availability-schema'
import type { ModelDefinition } from '@shared/lib/llm-provider/model-catalog-schema'

/** Model policy comes from the selected connection's provider. */
export function useProviderModelAvailability(connection: Pick<ConnectionInfo, 'id' | 'isConfigured' | 'supportsModelAvailability' | 'modelAvailabilityRevision'> | undefined) {
  const id = connection?.id
  const enabled = !!id && connection?.isConfigured === true && connection.supportsModelAvailability === true
  const query = useQuery({
    queryKey: ['provider-model-availability', id, connection?.modelAvailabilityRevision ?? null],
    enabled,
    queryFn: async () => {
      const response = await apiFetch(`/api/llm-connections/${encodeURIComponent(id!)}/model-availability`)
      if (!response.ok) throw new Error('Could not load model availability')
      const data: unknown = await response.json()
      return data === null ? null : modelAvailabilitySchema.parse(data)
    },
    staleTime: 30_000,
  })
  const availability = enabled ? query.data ?? null : null
  const { refetch } = query
  // `refetch` runs even for a disabled query, so only a provider that restricts asks.
  const refresh = useCallback(async () => {
    if (enabled) await refetch()
  }, [enabled, refetch])
  return useMemo(() => {
    const reasons = new Map(availability?.unavailable.map(entry => [entry.modelId, entry.reason]))
    /** The provider's reason a model is unavailable, or undefined when it can run. */
    const reasonFor = (model: ModelDefinition) => reasons.get(model.id)
    const isUnavailable = (model: ModelDefinition) => reasons.has(model.id)
    return {
      availability,
      updatedAt: query.dataUpdatedAt,
      isUnavailable,
      reasonFor,
      refresh,
    }
  }, [availability, query.dataUpdatedAt, refresh])
}
