import { describe, expect, it } from 'vitest'

import {
  buildTopupHandoffUrl,
  isPlatformOrgAdmin,
  paywallBillingDetailsFromSnapshot,
  resolveOrgBillingUrl,
  resolvePaywallCta,
  subscriptionRequiredFromBilling,
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

describe('buildTopupHandoffUrl', () => {
  it('appends the intent and the return deep link', () => {
    expect(buildTopupHandoffUrl(HREF, 'superagent')).toBe(
      `${HREF}&intent=topup&return_app=superagent%3A%2F%2Fbilling-updated`,
    )
  })

  it('uses the dev scheme when the app runs unpackaged', () => {
    expect(buildTopupHandoffUrl(HREF, 'superagent-dev')).toContain(
      'return_app=superagent-dev%3A%2F%2Fbilling-updated',
    )
  })

  it('omits return_app when the protocol scheme is unknown', () => {
    const url = buildTopupHandoffUrl(HREF, undefined)
    expect(url).toContain('intent=topup')
    expect(url).not.toContain('return_app')
  })

  it('returns null for a missing or unparseable billing href', () => {
    expect(buildTopupHandoffUrl(null, 'superagent')).toBeNull()
    expect(buildTopupHandoffUrl('not a url', 'superagent')).toBeNull()
  })
})

describe('subscriptionRequiredFromBilling', () => {
  it('treats a live plan as subscribed and a canceled or unset plan as required', () => {
    expect(subscriptionRequiredFromBilling({ configured: false, subscription: { status: null } })).toBe(true)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'canceled' } })).toBe(true)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'active' } })).toBe(false)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'cancellation_scheduled' } })).toBe(false)
    expect(subscriptionRequiredFromBilling({ configured: true, subscription: { status: 'past_due' } })).toBeUndefined()
    expect(subscriptionRequiredFromBilling(undefined)).toBeUndefined()
  })
})

describe('paywallBillingDetailsFromSnapshot', () => {
  it('keeps balances, payment method, and auto-reload details', () => {
    expect(paywallBillingDetailsFromSnapshot({
      subscription: { status: 'active', paymentStatus: 'current' },
      seat: { balanceCents: 1250 },
      orgPool: { poolBalanceCents: 5000 },
      hasPaymentMethod: true,
      autoReload: { enabled: true, thresholdCents: 1000, topupAmountCents: 5000 },
    })).toEqual({
      subscriptionStatus: 'active',
      paymentStatus: 'current',
      seatBalanceCents: 1250,
      orgPoolBalanceCents: 5000,
      hasPaymentMethod: true,
      autoReload: { enabled: true, thresholdCents: 1000, topupAmountCents: 5000 },
    })
  })
})

describe('resolvePaywallCta', () => {
  it('falls back to a billing button when the proxy omitted the flag', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: undefined,
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'go_to_billing', href: HREF })
  })

  it('returns subscribe when an admin needs a plan', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: true,
      role: 'owner',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'subscribe', href: HREF })
  })

  it('asks an admin for every write action, including subscribe', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: true,
      role: 'member',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'ask_admin', href: HREF })
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
    })).toEqual({ kind: 'ask_admin', href: HREF })
  })

  it('asks for a card when the admin has no payment method yet', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'admin',
      hasPaymentMethod: false,
      billingHref: HREF,
    })).toEqual({ kind: 'add_card', href: HREF })
  })

  it('does not guess add-card when the payment method is unknown', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'admin',
      hasPaymentMethod: undefined,
      billingHref: HREF,
    })).toEqual({ kind: 'go_to_billing', href: HREF })
  })

  it('treats a scheduled cancellation as a usage-credit path', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: subscriptionRequiredFromBilling({
        configured: true,
        subscription: { status: 'cancellation_scheduled' },
      }),
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'topup', href: HREF })
  })

  it('returns the top-up CTA when the admin already has a card', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'owner',
      hasPaymentMethod: true,
      billingHref: HREF,
    })).toEqual({ kind: 'topup', href: HREF })
  })

  it('prioritizes fixing a failed payment for an admin', () => {
    expect(resolvePaywallCta({
      subscriptionRequired: false,
      role: 'owner',
      hasPaymentMethod: true,
      paymentStatus: 'past_due',
      billingHref: HREF,
    })).toEqual({ kind: 'manage_payment', href: HREF })
  })
})
