import { describe, expect, it } from 'vitest'

import { isPlatformOrgAdmin, resolvePaywallCta, TOPUP_AMOUNTS_CENTS } from './paywall-cta'

const HREF = 'https://platform.example.com/dashboard/organizations/org_123?tab=billing'

describe('isPlatformOrgAdmin', () => {
  it('is true for owner and admin', () => {
    expect(isPlatformOrgAdmin('owner')).toBe(true)
    expect(isPlatformOrgAdmin('admin')).toBe(true)
  })

  it('is false for member and missing role', () => {
    expect(isPlatformOrgAdmin('member')).toBe(false)
    expect(isPlatformOrgAdmin(null)).toBe(false)
    expect(isPlatformOrgAdmin(undefined)).toBe(false)
  })
})

describe('resolvePaywallCta', () => {
  it('falls back to the billing link when the proxy omitted the flag', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: undefined,
      isOrgAdmin: true,
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'billing_link' })
  })

  it('returns subscribe when the proxy says subscription is required', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: true,
      isOrgAdmin: false,
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'subscribe', href: HREF })
  })

  it('asks an admin to top up when the member cannot bill', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      isOrgAdmin: false,
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'ask_admin' })
  })

  it('asks for a card when the admin has no payment method yet', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      isOrgAdmin: true,
      hasPaymentMethod: false,
      billingHref: HREF,
    })).toEqual({ kind: 'add_card', href: HREF })
  })

  it('treats an unknown payment method as add-card', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      isOrgAdmin: true,
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'add_card', href: HREF })
  })

  it('returns top-up amounts when the admin already has a card', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      isOrgAdmin: true,
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'topup', href: HREF, amountsCents: TOPUP_AMOUNTS_CENTS })
  })
})
