import type { ParsedPlatformBillingInfo, SubscriptionCreditScope } from '@shared/lib/types/skillset-schema'

/**
 * Wording for the monthly subscription credit, by who it belongs to. A pooled
 * org (`creditScope: 'org'`) shares one allowance across every member, so the
 * same numbers must never be called the member's own seat.
 */
export const SUBSCRIPTION_CREDIT_COPY: Record<SubscriptionCreditScope, { credits: string; allowance: string }> = {
  seat: { credits: 'Seat credits', allowance: 'Seat allowance' },
  org: { credits: 'Team plan credits', allowance: 'Team plan allowance' },
}

export function subscriptionCreditScope(
  billing: Pick<ParsedPlatformBillingInfo, 'subscription'> | null | undefined,
): SubscriptionCreditScope {
  return billing?.subscription.creditScope === 'org' ? 'org' : 'seat'
}
