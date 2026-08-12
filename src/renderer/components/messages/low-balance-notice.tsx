import { useCallback, useState } from 'react'

import { PROGRESS_THRESHOLDS } from '@renderer/components/ui/progress'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { useSettings } from '@renderer/hooks/use-settings'
import { getActiveTarget } from '@renderer/lib/api-target'
import { LowBalanceCard } from './insufficient-balance-card'

/**
 * The warning before the wall: credits are low but agents still run.
 *
 * Renders nothing unless the workspace is actually spending platform credits —
 * a BYOK provider, a disconnected account, or an org with no seat has no balance
 * this could be about, and must never be asked to top one up.
 */

/**
 * Which side of the meter the balance is on, or null when there is nothing to
 * warn about. Bands rather than a raw percent because the dismissal is keyed to
 * them: dismissing "running low" should not also silence "nearly out".
 */
type Band = 'warning' | 'critical'

function bandFor(percentRemaining: number): Band | null {
  // At zero the hard 402 is already the accurate message; warning about a
  // balance that has run out would only duplicate it.
  if (percentRemaining <= 0) return null
  if (percentRemaining <= PROGRESS_THRESHOLDS.critical) return 'critical'
  if (percentRemaining <= PROGRESS_THRESHOLDS.warning) return 'warning'
  return null
}

/**
 * Remembers the band a user dismissed, per workspace, so the notice stays gone
 * for that band but returns when the balance drops into the next one. A warning
 * that cannot come back is not much of a warning; one that cannot be silenced,
 * on every session, for as long as the balance is low, is worse than none.
 */
function useDismissedBand(): [Band | null, (band: Band) => void] {
  const key = `low-balance-dismissed.${getActiveTarget()}`
  const [dismissed, setDismissed] = useState<Band | null>(
    () => (localStorage.getItem(key) as Band | null) ?? null,
  )
  const dismiss = useCallback((band: Band) => {
    localStorage.setItem(key, band)
    setDismissed(band)
  }, [key])
  return [dismissed, dismiss]
}

export function LowBalanceNotice() {
  const { data: platformAuth } = usePlatformAuthStatus()
  const { data: settings } = useSettings()
  const [dismissedBand, dismiss] = useDismissedBand()

  const platformBaseUrl = platformAuth?.platformBaseUrl
  const orgId = platformAuth?.orgId
  // Gate the query itself, not just the render: a workspace that cannot have a
  // platform balance should never fetch one.
  const spendsPlatformCredits =
    settings?.llmProvider === 'platform' &&
    !!platformAuth?.connected &&
    !!platformBaseUrl &&
    !!orgId
  const { data } = useBillingInfo(spendsPlatformCredits)

  const seat = data?.billing?.configured ? data.billing.seat : null
  if (!spendsPlatformCredits || !seat || seat.startingBalanceCents <= 0) return null

  const percentRemaining = (seat.balanceCents / seat.startingBalanceCents) * 100
  const band = bandFor(percentRemaining)
  // Dropping from warning into critical un-dismisses: the second band is a
  // different, more urgent statement than the one that was waved away.
  if (!band || band === dismissedBand || (band === 'warning' && dismissedBand === 'critical')) {
    return null
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <LowBalanceCard
        billingUrl={`${platformBaseUrl}/dashboard/organizations/${orgId}?tab=billing`}
        onDismiss={() => dismiss(band)}
      />
    </div>
  )
}
