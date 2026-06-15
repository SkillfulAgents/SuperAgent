import { ArrowUpRight, Wallet } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { useSettings } from '@renderer/hooks/use-settings'

// A platform billing 402 is the only provider error we can resolve in-product
// (subscribe / top up the org wallet).
function isInsufficientBalanceError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('insufficient balance') ||
    lower.includes('insufficient_balance') ||
    (lower.includes('402') && lower.includes('top up'))
  )
}

// Returns the org billing URL when `message` is a platform billing 402 the
// workspace can act on (platform LLM in use, connected, org known); otherwise
// null. Callers use null to fall through to the generic provider-error card —
// e.g. a BYOK provider returning a 402 must not surface a platform billing CTA.
export function usePlatformBillingUrl(message: string): string | null {
  const { data: platformAuth } = usePlatformAuthStatus()
  const { data: settings } = useSettings()

  if (!isInsufficientBalanceError(message)) return null
  if (settings?.llmProvider !== 'platform') return null
  if (!platformAuth?.connected) return null

  const platformBaseUrl = platformAuth.platformBaseUrl
  const orgId = platformAuth.orgId
  if (!platformBaseUrl || !orgId) return null

  return `${platformBaseUrl}/dashboard/organizations/${orgId}?tab=billing`
}

export function InsufficientBalanceCard({
  billingUrl,
  'data-testid': testId,
}: {
  billingUrl: string
  'data-testid'?: string
}) {
  async function handleGoToBilling() {
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(billingUrl)
      return
    }
    window.open(billingUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      className="rounded-[12px] border bg-muted/30 shadow-md p-4"
      data-testid={testId ?? 'insufficient-balance-card'}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
          <Wallet className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">Insufficient balance</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Subscribe or top up to continue running agents.
          </p>
          <Button size="sm" className="mt-3 gap-1.5" onClick={() => void handleGoToBilling()}>
            Go to billing
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
