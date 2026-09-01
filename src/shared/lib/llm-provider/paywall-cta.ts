export const TOPUP_AMOUNTS_CENTS = [5_000, 10_000, 20_000, 40_000] as const
export const MIN_TOPUP_DOLLARS = 20
export const MAX_TOPUP_DOLLARS = 50_000

export const ORG_BILLING_PATH = '/dashboard/organizations/{orgId}?tab=billing'

export type PaywallCta =
  | { kind: 'subscribe'; href: string | null }
  | { kind: 'ask_admin'; href: string | null }
  | { kind: 'add_card'; href: string | null }
  | { kind: 'topup'; href: string | null; amountsCents: readonly number[] }
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

export function formatTopupDollars(cents: number): string {
  return `$${cents / 100}`
}

// Whole dollars only; the platform's minimum top-up is $20.
export function parseCustomTopupDollars(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const dollars = Number(trimmed)
  return dollars >= MIN_TOPUP_DOLLARS && dollars <= MAX_TOPUP_DOLLARS ? dollars : null
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
    return { kind: 'topup', href: input.billingHref, amountsCents: TOPUP_AMOUNTS_CENTS }
  }
  return { kind: 'add_card', href: input.billingHref }
}
