import { ArrowUpRight, Info, X } from 'lucide-react'

import { cn } from '@shared/lib/utils'

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

/**
 * The two billing banners, in the error banner's frame and metrics (see
 * RequestError): a leading glyph, one line of copy, and the billing link where
 * the error banner puts "More details".
 *
 * Red for the hard stop, blue for the warning — the split is severity, not
 * source. What sets the hard stop apart from the other red banners is that it
 * carries an action; every other error can only be retried.
 *
 * Tinted fills stay opaque in dark for the same reason as the red banner — the
 * transcript scrolls behind the overlay footer.
 */
const BANNER_TONES = {
  stop: {
    container: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
    action: 'text-red-700/85 hover:text-red-700 dark:text-red-300/85 dark:hover:text-red-300',
  },
  warn: {
    container: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    action: 'text-blue-700/85 hover:text-blue-700 dark:text-blue-300/85 dark:hover:text-blue-300',
  },
} as const

function BillingBanner({
  message,
  billingUrl,
  tone,
  testId,
  onDismiss,
}: {
  message: string
  billingUrl: string
  tone: keyof typeof BANNER_TONES
  testId: string
  /** Warnings can be waved away; the hard stop has nothing to dismiss to. */
  onDismiss?: () => void
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
      className={cn('rounded-md px-3 py-2 text-xs', BANNER_TONES[tone].container)}
      data-testid={testId}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{message}</span>
        <button
          type="button"
          onClick={() => void handleGoToBilling()}
          className={cn(
            'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            BANNER_TONES[tone].action,
          )}
        >
          Go to billing
          <ArrowUpRight className="h-3 w-3" />
        </button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              'shrink-0 cursor-pointer rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              BANNER_TONES[tone].action,
            )}
            aria-label="Dismiss balance warning"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}

/** The turn is already dead: the 402 has landed and nothing runs until paid. */
export function InsufficientBalanceCard({
  billingUrl,
  'data-testid': testId,
}: {
  billingUrl: string
  'data-testid'?: string
}) {
  return (
    <BillingBanner
      message="Insufficient balance: Subscribe or top up to continue running agents."
      billingUrl={billingUrl}
      tone="stop"
      testId={testId ?? 'insufficient-balance-card'}
    />
  )
}

/**
 * The warning before the wall — credits are low but agents still run, so this is
 * the one billing message a user can act on BEFORE losing a turn.
 *
 * Copy is a statement plus the concrete thing to do, not a number: "18%
 * remaining" reads as data to interpret, where "add more credits" is the action.
 */
export function LowBalanceCard({
  billingUrl,
  onDismiss,
  'data-testid': testId,
}: {
  billingUrl: string
  onDismiss?: () => void
  'data-testid'?: string
}) {
  return (
    <BillingBanner
      message="Balance running low. Add more credits to avoid interrupting your agents."
      billingUrl={billingUrl}
      tone="warn"
      testId={testId ?? 'low-balance-card'}
      onDismiss={onDismiss}
    />
  )
}
