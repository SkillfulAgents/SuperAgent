export const ORG_BILLING_PATH = '/dashboard/organizations/{orgId}?tab=billing'
export const BILLING_RESUME_SYSTEM_PROMPT =
  '[SYSTEM] Continue the interrupted request from where you stopped. Do not repeat work that was already completed.'

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

export function resolveOrgBillingUrl(
  org: { connected?: boolean; platformBaseUrl?: string | null; orgId?: string | null } | null | undefined,
): string | null {
  if (!org?.connected || !org.orgId || !org.platformBaseUrl) return null
  const origin = org.platformBaseUrl.replace(/\/$/, '')
  return `${origin}${ORG_BILLING_PATH.replaceAll('{orgId}', org.orgId)}`
}

// Dashboard hand-off for "Add usage": auto-opens the top-up dialog on arrival
// and asks the website to deep-link back once the purchase lands (SUP-725).
export function buildTopupHandoffUrl(
  billingHref: string | null,
  protocolScheme: string | null | undefined,
): string | null {
  if (!billingHref) return null
  let url: URL
  try {
    url = new URL(billingHref)
  } catch {
    return null
  }
  url.searchParams.set('intent', 'topup')
  if (protocolScheme) {
    url.searchParams.set('return_app', `${protocolScheme}://billing-updated`)
  }
  return url.toString()
}

const ACTIVE_SUBSCRIPTION = new Set(['active', 'trialing', 'cancellation_scheduled'])
const UNRESOLVED_SUBSCRIPTION = new Set(['past_due', 'blocked', 'payment_failed'])
const PAYMENT_NEEDS_ATTENTION = new Set(['past_due', 'blocked', 'payment_failed'])
export function isArmablePaywallCta(kind: PaywallCta['kind']): boolean {
  return kind === 'subscribe' || kind === 'add_card' || kind === 'topup' || kind === 'manage_payment'
}

// CLI 402s drop `subscription_required`. The billing snapshot still knows
// whether this org needs a plan vs usage credit.
export function subscriptionRequiredFromBilling(
  billing: {
    configured?: boolean
    subscription?: { status?: string | null }
  } | null | undefined,
): boolean | undefined {
  if (!billing) return undefined
  if (billing.configured === false) return true
  const status = billing.subscription?.status
  if (!status) return undefined
  if (ACTIVE_SUBSCRIPTION.has(status)) return false
  if (UNRESOLVED_SUBSCRIPTION.has(status)) return undefined
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
  if (input.subscriptionRequired === undefined) {
    return { kind: 'go_to_billing', href: input.billingHref }
  }
  if (input.subscriptionRequired) {
    return writeActionCta('subscribe', input.role, input.billingHref)
  }
  if (input.role == null) {
    return { kind: 'go_to_billing', href: input.billingHref }
  }
  if (!isPlatformOrgAdmin(input.role)) {
    return { kind: 'ask_admin', href: input.billingHref }
  }
  if (input.hasPaymentMethod === true) {
    return { kind: 'topup', href: input.billingHref }
  }
  if (input.hasPaymentMethod === false) {
    return { kind: 'add_card', href: input.billingHref }
  }
  return { kind: 'go_to_billing', href: input.billingHref }
}
