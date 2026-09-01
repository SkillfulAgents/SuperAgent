export const ORG_BILLING_PATH = '/dashboard/organizations/{orgId}?tab=billing'

export type PaywallCta =
  | { kind: 'subscribe'; href: string | null }
  | { kind: 'ask_admin'; href: string | null }
  | { kind: 'add_card'; href: string | null }
  | { kind: 'topup'; href: string | null }
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

export function resolvePaywallCta(input: {
  subscriptionRequired: boolean | undefined
  role: string | null | undefined
  hasPaymentMethod: boolean | undefined
  billingHref: string | null
}): PaywallCta {
  // Proxy omitted the flag (legacy 402): no branching info, so offer billing.
  if (input.subscriptionRequired === undefined) {
    return { kind: 'go_to_billing', href: input.billingHref }
  }
  if (input.subscriptionRequired) {
    return { kind: 'subscribe', href: input.billingHref }
  }
  // Role unknown (settings-backed / self-hosted auth): don't strand a possible
  // owner on "ask an admin" — show a plain billing button instead.
  if (input.role == null) {
    return { kind: 'go_to_billing', href: input.billingHref }
  }
  if (!isPlatformOrgAdmin(input.role)) {
    return { kind: 'ask_admin', href: input.billingHref }
  }
  if (input.hasPaymentMethod === true) {
    return { kind: 'topup', href: input.billingHref }
  }
  return { kind: 'add_card', href: input.billingHref }
}
