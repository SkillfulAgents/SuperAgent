import { useCallback, useMemo } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'
import { modelAvailabilitySchema, type ModelAvailability } from '@shared/lib/llm-provider/model-availability-schema'
import type { ModelDefinition } from '@shared/lib/llm-provider/model-catalog-schema'

type AvailabilityConnection = Pick<ConnectionInfo, 'id' | 'isConfigured' | 'supportsModelAvailability' | 'modelAvailabilityRevision'>

// Only a provider that can restrict models is asked.
function restricts(connection: AvailabilityConnection | undefined): connection is AvailabilityConnection {
  return !!connection?.id && connection.isConfigured === true && connection.supportsModelAvailability === true
}

function availabilityKey(connection: AvailabilityConnection | undefined) {
  return ['provider-model-availability', connection?.id, connection?.modelAvailabilityRevision ?? null] as const
}

// `fresh` re-reads the provider's source rather than its cache (after an upgrade).
async function fetchAvailability(id: string, fresh = false): Promise<ModelAvailability | null> {
  const response = await apiFetch(`/api/llm-connections/${encodeURIComponent(id)}/model-availability${fresh ? '?fresh=1' : ''}`)
  if (!response.ok) throw new Error('Could not load model availability')
  const data: unknown = await response.json()
  return data === null ? null : modelAvailabilitySchema.parse(data)
}

/** Model policy comes from the selected connection's provider. */
export function useProviderModelAvailability(connection: AvailabilityConnection | undefined) {
  const queryClient = useQueryClient()
  const enabled = restricts(connection)
  const key = availabilityKey(connection)
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: () => fetchAvailability(connection!.id),
    staleTime: 30_000,
  })
  const availability = enabled ? query.data ?? null : null
  const id = connection?.id
  const revision = connection?.modelAvailabilityRevision ?? null
  // A fresh read from the provider's source, for after an upgrade or a refusal.
  const refresh = useCallback(async () => {
    if (!enabled || !id) return
    queryClient.setQueryData(['provider-model-availability', id, revision], await fetchAvailability(id, true))
  }, [enabled, id, revision, queryClient])
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

/**
 * Availability for several connections at once, for choices that span them
 * (the composer's list of saved defaults). The provider's reason a model on a
 * connection cannot run, or undefined when it can.
 */
export function useModelAvailabilities(connections: readonly AvailabilityConnection[]) {
  const restricting = connections.filter(restricts)
  return useQueries({
    queries: restricting.map(connection => ({
      queryKey: availabilityKey(connection),
      queryFn: () => fetchAvailability(connection.id),
      staleTime: 30_000,
    })),
    combine: (results) => {
      const byConnection = new Map(restricting.map((connection, index) => [connection.id, results[index]?.data ?? null]))
      return {
        /** Null for a connection whose availability is still loading or unrestricted. */
        availabilityOf: (llmProviderId: string | undefined) => (llmProviderId ? byConnection.get(llmProviderId) ?? null : null),
        reasonFor: (llmProviderId: string | undefined, modelId: string | undefined) =>
          llmProviderId && modelId
            ? byConnection.get(llmProviderId)?.unavailable.find(entry => entry.modelId === modelId)?.reason
            : undefined,
      }
    },
  })
}
