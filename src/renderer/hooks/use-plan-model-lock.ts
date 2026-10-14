import { useMemo } from 'react'

import type { PlanLock } from '@renderer/components/messages/model-family-list'
import { usePlanUpgrade } from '@renderer/context/plan-upgrade-context'
import { useProviderModelAvailability } from '@renderer/hooks/use-provider-model-availability'
import type { ConnectionInfo } from '@shared/lib/llm-provider/connection-schema'

/**
 * Adapt a provider's connection-scoped availability to the picker's lock UI.
 */
export function usePlanModelLock(connection: Pick<ConnectionInfo, 'id' | 'isConfigured' | 'supportsModelAvailability' | 'modelAvailabilityRevision'> | undefined): PlanLock | undefined {
  const { availability, isUnavailable } = useProviderModelAvailability(connection)
  const openUpgrade = usePlanUpgrade()
  const unavailableModelIds = availability?.unavailableModelIds
  const planName = availability?.restrictionName ?? undefined
  return useMemo(() => {
    if (!unavailableModelIds?.length) return undefined
    return {
      isLocked: isUnavailable,
      onLockedPick: (model) => openUpgrade({ model: model.id, connectionId: connection?.id }),
      planName,
    }
  }, [unavailableModelIds, isUnavailable, openUpgrade, planName, connection?.id])
}
