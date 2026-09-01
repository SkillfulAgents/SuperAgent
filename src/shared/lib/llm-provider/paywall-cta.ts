export const TOPUP_AMOUNTS_CENTS = [2_000, 5_000, 10_000, 20_000] as const

export type PaywallCta =
  | { kind: 'subscribe'; href: string | null }
  | { kind: 'ask_admin' }
  | { kind: 'add_card'; href: string | null }
  | { kind: 'topup'; href: string | null; amountsCents: readonly number[] }
  | { kind: 'billing_link' }

export function isPlatformOrgAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export function formatTopupDollars(cents: number): string {
  return `$${cents / 100}`
}

export function resolvePaywallCta(input: {
  subscriptionRequired: boolean | undefined
  isOrgAdmin: boolean
  hasPaymentMethod: boolean | undefined
  billingHref: string | null
}): PaywallCta {
  if (input.subscriptionRequired === undefined) {
    return { kind: 'billing_link' }
  }
  if (input.subscriptionRequired) {
    return { kind: 'subscribe', href: input.billingHref }
  }
  if (!input.isOrgAdmin) {
    return { kind: 'ask_admin' }
  }
  if (input.hasPaymentMethod === true) {
    return { kind: 'topup', href: input.billingHref, amountsCents: TOPUP_AMOUNTS_CENTS }
  }
  return { kind: 'add_card', href: input.billingHref }
}
