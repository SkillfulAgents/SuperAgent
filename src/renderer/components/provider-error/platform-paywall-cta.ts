export type PaywallCta =
  | { kind: 'subscribe'; href: string | null }
  | { kind: 'ask_admin'; href: string | null }
  | { kind: 'add_card'; href: string | null }
  | { kind: 'topup'; href: string | null }
  | { kind: 'manage_payment'; href: string | null }
  | { kind: 'go_to_billing'; href: string | null }

export function isPlatformOrgAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

// "Add usage" opens the dashboard top-up dialog. No return deep link.
export function buildTopupHandoffUrl(billingHref: string | null): string | null {
  if (!billingHref) return null
  let url: URL
  try {
    url = new URL(billingHref)
  } catch {
    return null
  }
  url.searchParams.set('intent', 'topup')
  return url.toString()
}

const ACTIVE_SUBSCRIPTION = new Set(['active', 'trialing', 'cancellation_scheduled'])
// Payment problems: neither "needs a plan" nor "needs credit" until the admin fixes payment.
const PAYMENT_NEEDS_ATTENTION = new Set(['past_due', 'blocked', 'payment_failed'])

// CLI 402s drop `subscription_required`; the billing snapshot still knows plan vs credit.
export function subscriptionRequiredFromBilling(
  billing: { configured?: boolean; subscription?: { status?: string | null } } | null | undefined,
): boolean | undefined {
  if (!billing) return undefined
  if (billing.configured === false) return true
  const status = billing.subscription?.status
  if (!status) return undefined
  if (ACTIVE_SUBSCRIPTION.has(status)) return false
  if (PAYMENT_NEEDS_ATTENTION.has(status)) return undefined
  return true
}

function writeActionCta(
  kind: 'subscribe' | 'add_card' | 'topup' | 'manage_payment',
  role: string | null | undefined,
  billingHref: string | null,
): PaywallCta {
  if (role == null) return { kind: 'go_to_billing', href: billingHref }
  if (!isPlatformOrgAdmin(role)) return { kind: 'ask_admin', href: billingHref }
  return { kind, href: billingHref }
}

export function resolvePaywallCta(input: {
  subscriptionRequired: boolean | undefined
  role: string | null | undefined
  hasPaymentMethod: boolean | undefined
  paymentStatus?: string | null
  billingHref: string | null
}): PaywallCta {
  if (input.paymentStatus && PAYMENT_NEEDS_ATTENTION.has(input.paymentStatus)) {
    return writeActionCta('manage_payment', input.role, input.billingHref)
  }
  // Proxy omitted the flag (legacy 402): no branching info, so offer billing.
  if (input.subscriptionRequired === undefined) return { kind: 'go_to_billing', href: input.billingHref }
  if (input.subscriptionRequired) return writeActionCta('subscribe', input.role, input.billingHref)
  if (input.role == null) return { kind: 'go_to_billing', href: input.billingHref }
  if (!isPlatformOrgAdmin(input.role)) return { kind: 'ask_admin', href: input.billingHref }
  if (input.hasPaymentMethod === true) return { kind: 'topup', href: input.billingHref }
  if (input.hasPaymentMethod === false) return { kind: 'add_card', href: input.billingHref }
  return { kind: 'go_to_billing', href: input.billingHref }
}
