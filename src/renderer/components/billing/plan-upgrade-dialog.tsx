import { useEffect, useState } from 'react'
import { ArrowUpRight, Loader2 } from 'lucide-react'

import { notInPlanText } from '@renderer/components/messages/model-family-list'
import { BillingEmbedFrame } from '@renderer/components/provider-error/billing-embed-frame'
import { isPlatformOrgAdmin } from '@renderer/components/provider-error/platform-paywall-cta'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import type { PlanUpgradeRequest } from '@renderer/context/plan-upgrade-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { pendingPlanChangeText, usePlatformPlan } from '@renderer/hooks/use-platform-plan'
import { isElectron } from '@renderer/lib/env'
import { openExternalUrl } from '@renderer/lib/open-external'
import { PLATFORM_CATALOG } from '@shared/lib/llm-provider/builtin-catalogs'
import { orgBillingUrl } from '@shared/lib/llm-provider/platform-error-presentation'
import { planModelLabel } from '@shared/lib/llm-provider/plan-model-policy'
import { cn } from '@shared/lib/utils'

/**
 * Change the workspace's plan, from a locked model, a 403 or the Account
 * screen. Web on a cloud workspace frames the platform's full billing page (the
 * only place it allows framing); Electron and other hosts hand off to the
 * browser. Either way the plan is re-read on return and on close, because the
 * billing page's plan change does not tell the host it happened.
 */
export function PlanUpgradeDialog({ request, onClose }: { request: PlanUpgradeRequest; onClose: () => void }) {
  const { data: platformAuth } = usePlatformAuthStatus()
  const { plan, excludedLabel, pendingPlanChange, isDenied, updatedAt, refresh } = usePlatformPlan()
  const [openedAt] = useState(() => Date.now())
  const [handedOff, setHandedOff] = useState(false)
  const inApp = !isElectron() && platformAuth?.platformControlled === true
  const role = platformAuth?.role
  const canManage = role == null || isPlatformOrgAdmin(role)
  const billingHref = orgBillingUrl(platformAuth?.platformBaseUrl, platformAuth?.orgId)
  const modelLabel = request.model ? planModelLabel(request.model, PLATFORM_CATALOG) : null
  // Only a snapshot fetched after opening may say the model is now allowed.
  const unlocked = !!request.model && updatedAt > openedAt && !isDenied(request.model)

  // Re-read the plan on open (another window may have changed it) and whenever
  // the user comes back from the billing page in the browser.
  useEffect(() => {
    void refresh()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [refresh])

  const close = () => {
    void refresh()
    onClose()
  }

  const pending = pendingPlanChange ? ` ${pendingPlanChangeText(pendingPlanChange)}.` : ''
  let title: string
  let description: string
  if (unlocked && modelLabel) {
    title = `Your plan now includes ${modelLabel}`
    description = `Model access may take a moment to update. Try ${modelLabel} from the model menu.`
  } else if (modelLabel) {
    title = `Upgrade to use ${modelLabel}`
    description = `${notInPlanText(modelLabel, plan?.name)}${canManage ? ' Upgrade the plan to use it.' : ' Ask a workspace owner or admin to upgrade the plan.'}${pending}`
  } else {
    title = 'Change plan'
    description = plan
      ? `Your workspace is on ${plan.name}${excludedLabel ? `, which excludes ${excludedLabel}` : ''}.${pending}`
      : 'Choose a plan for your workspace.'
  }
  const embedded = inApp && canManage && !unlocked

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className={cn('gap-4', embedded ? 'sm:max-w-3xl' : 'sm:max-w-md')} data-testid="plan-upgrade-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {unlocked || !canManage ? (
          <div className="flex justify-end">
            <Button onClick={close}>{unlocked ? 'Done' : 'Close'}</Button>
          </div>
        ) : embedded ? (
          <BillingEmbedFrame
            orgId={platformAuth?.orgId ?? null}
            platformBaseUrl={platformAuth?.platformBaseUrl ?? null}
            fallbackHref={billingHref}
            onBillingUpdated={() => void refresh()}
            onOpenExternal={() => setHandedOff(true)}
          />
        ) : (
          <div className="flex flex-col items-start gap-3">
            {handedOff && (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="plan-upgrade-waiting">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Finish in your browser. This updates when you come back.
              </p>
            )}
            <Button
              disabled={!billingHref}
              onClick={() => {
                if (!billingHref) return
                void openExternalUrl(billingHref)
                setHandedOff(true)
              }}
            >
              {handedOff ? 'Open billing again' : 'Open billing'}
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
