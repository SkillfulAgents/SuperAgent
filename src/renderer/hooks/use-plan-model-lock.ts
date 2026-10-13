import { useMemo } from 'react'

import type { PlanLock } from '@renderer/components/messages/model-family-list'
import { usePlanUpgrade } from '@renderer/context/plan-upgrade-context'
import { usePlatformPlan } from '@renderer/hooks/use-platform-plan'

/**
 * The plan lock for a picker showing `provider`'s catalog. Only platform
 * connections are restricted by the workspace's plan; every other provider,
 * an unsubscribed workspace and a plan with an empty denylist get none.
 */
export function usePlanModelLock(provider: string | undefined): PlanLock | undefined {
  const isPlatform = provider === 'platform'
  const { plan, deniedModels, isDenied } = usePlatformPlan(isPlatform)
  const openUpgrade = usePlanUpgrade()
  const planName = plan?.name
  return useMemo(() => {
    if (!isPlatform || deniedModels.length === 0) return undefined
    return {
      isLocked: (model) => isDenied(model.id),
      onLockedPick: (model) => openUpgrade({ model: model.id }),
      planName,
    }
  }, [isPlatform, deniedModels, isDenied, openUpgrade, planName])
}
