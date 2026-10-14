import { useMemo } from 'react'

import type { ModelLock } from '@renderer/components/messages/model-family-list'
import { useModelAvailabilityAction } from '@renderer/context/model-availability-action-context'
import { useProviderModelAvailability } from '@renderer/hooks/use-provider-model-availability'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'

/**
 * Adapt a provider's connection-scoped availability to the pickers' lock UI.
 * Undefined when the provider restricts nothing.
 */
export function useModelLock(connection: Pick<ConnectionInfo, 'id' | 'isConfigured' | 'supportsModelAvailability' | 'modelAvailabilityRevision'> | undefined): ModelLock | undefined {
  const { availability, isUnavailable, reasonFor } = useProviderModelAvailability(connection)
  const openAction = useModelAvailabilityAction()
  const connectionId = connection?.id
  return useMemo(() => {
    if (!availability?.unavailable.length) return undefined
    const { action } = availability
    return {
      isLocked: isUnavailable,
      reason: (model) => reasonFor(model) ?? '',
      action: action
        ? { label: action.label, run: (model) => openAction({ action, model: { id: model.id, label: model.label }, connectionId }) }
        : undefined,
    }
  }, [availability, isUnavailable, reasonFor, openAction, connectionId])
}
