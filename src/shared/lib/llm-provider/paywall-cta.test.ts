import { describe, expect, it } from 'vitest'

import {
  isPlatformOrgAdmin,
  parseCustomTopupDollars,
  resolveOrgBillingUrl,
  resolvePaywallCta,
  TOPUP_AMOUNTS_CENTS,
} from './paywall-cta'

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

describe('resolveOrgBillingUrl', () => {
  it('builds the billing URL from a connected org', () => {
    expect(resolveOrgBillingUrl({
      connected: true,
      platformBaseUrl: 'https://platform.example.com',
      orgId: 'org_123',
    })).toBe(HREF)
  })

  it('strips a trailing slash from the platform base URL', () => {
    expect(resolveOrgBillingUrl({
      connected: true,
      platformBaseUrl: 'https://platform.example.com/',
      orgId: 'org_123',
    })).toBe(HREF)
  })

  it('returns null when disconnected or org context is missing', () => {
    expect(resolveOrgBillingUrl(null)).toBeNull()
    expect(resolveOrgBillingUrl({ connected: false, platformBaseUrl: 'https://p.example.com', orgId: 'org_123' })).toBeNull()
    expect(resolveOrgBillingUrl({ connected: true, platformBaseUrl: null, orgId: 'org_123' })).toBeNull()
    expect(resolveOrgBillingUrl({ connected: true, platformBaseUrl: 'https://p.example.com', orgId: null })).toBeNull()
  })
})

describe('parseCustomTopupDollars', () => {
  it('accepts whole dollars at or above the minimum', () => {
    expect(parseCustomTopupDollars('20')).toBe(20)
    expect(parseCustomTopupDollars(' 150 ')).toBe(150)
  })

  it('rejects below-minimum, negative, fractional, and non-numeric input', () => {
    expect(parseCustomTopupDollars('19')).toBeNull()
    expect(parseCustomTopupDollars('-30')).toBeNull()
    expect(parseCustomTopupDollars('20.5')).toBeNull()
    expect(parseCustomTopupDollars('abc')).toBeNull()
    expect(parseCustomTopupDollars('')).toBeNull()
  })
})

describe('resolvePaywallCta', () => {
  it('falls back to the billing link when the proxy omitted the flag', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: undefined,
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'billing_link' })
  })

  it('returns subscribe when the proxy says subscription is required', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: true,
      role: 'member',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'subscribe', href: HREF })
  })

  it('shows a billing button, not ask-admin, when the role is unknown', () => {
    for (const role of [null, undefined]) {
      expect(resolvePaywallCta({
        subscriptionRequired: false,
        role,
        hasPaymentMethod: undefined,
        billingHref: HREF,
      })).toEqual({ kind: 'go_to_billing', href: HREF })
    }
  })

  it('asks an admin to top up when the member cannot bill', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'member',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'ask_admin' })
  })

  it('asks for a card when the admin has no payment method yet', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'admin',
      hasPaymentMethod: false,
      billingHref: HREF,
    })).toEqual({ kind: 'add_card', href: HREF })
  })

  it('treats an unknown payment method as add-card', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'admin',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'add_card', href: HREF })
  })

  it('returns top-up amounts when the admin already has a card', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'topup', href: HREF, amountsCents: TOPUP_AMOUNTS_CENTS })
  })
})
