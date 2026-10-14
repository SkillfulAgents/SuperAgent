import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from 'react'

import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { openExternalUrl } from '@renderer/lib/open-external'
import { orgBillingUrl } from '@shared/lib/llm-provider/platform-error-presentation'

const PlanUpgradeDialog = lazy(() =>
  import('@renderer/components/billing/plan-upgrade-dialog').then((m) => ({ default: m.PlanUpgradeDialog })),
)

export interface PlanUpgradeRequest {
  /** The model that prompted the upgrade (a locked pick or a 403); none = "Change plan". */
  model?: string
  /** Connection that supplied the restriction, for a fresh availability check. */
  connectionId?: string
}

type OpenPlanUpgrade = (request?: PlanUpgradeRequest) => void

const PlanUpgradeContext = createContext<OpenPlanUpgrade | null>(null)

/**
 * Owns the one plan-upgrade dialog, so a locked model in any picker, the 403
 * card and the Account screen's "Change plan" all open the same flow.
 */
export function PlanUpgradeProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PlanUpgradeRequest | null>(null)
  const open = useCallback<OpenPlanUpgrade>((next = {}) => setRequest(next), [])
  return (
    <PlanUpgradeContext.Provider value={open}>
      {children}
      {request && (
        <Suspense fallback={null}>
          <PlanUpgradeDialog request={request} onClose={() => setRequest(null)} />
        </Suspense>
      )}
    </PlanUpgradeContext.Provider>
  )
}

/**
 * Opens the plan-upgrade flow. Hosts without the provider (the standalone
 * quick-dispatch window) hand off to the billing page in the browser instead.
 */
export function usePlanUpgrade(): OpenPlanUpgrade {
  const open = useContext(PlanUpgradeContext)
  const { data: platformAuth } = usePlatformAuthStatus()
  const billingHref = orgBillingUrl(platformAuth?.platformBaseUrl, platformAuth?.orgId)
  const handOff = useCallback<OpenPlanUpgrade>(() => {
    if (billingHref) void openExternalUrl(billingHref)
  }, [billingHref])
  return open ?? handOff
}
