import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { extractSubscriptionRequired } from '@shared/lib/llm-provider/platform-error-presentation'
import { HomeEmptyClouds } from '@renderer/components/home/home-empty-clouds'
import { Button } from '@renderer/components/ui/button'
import { useBillingInfo } from '@renderer/hooks/use-billing-info'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { openExternalUrl } from '@renderer/lib/open-external'

import type { ProviderErrorComponentProps } from './provider-error-registry'

// ---------------------------------------------------------------------------
// CTA resolution (pure)
// ---------------------------------------------------------------------------

const ORG_BILLING_PATH = '/dashboard/organizations/{orgId}?tab=billing'

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

// "Add usage" hand-off: auto-open the top-up dialog and deep-link back when done.
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

// CLI 402s drop `subscription_required`; the billing snapshot still knows plan vs credit.
export function subscriptionRequiredFromBilling(
  billing: { configured?: boolean; subscription?: { status?: string | null } } | null | undefined,
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
  if (input.subscriptionRequired === undefined) return { kind: 'go_to_billing', href: input.billingHref }
  if (input.subscriptionRequired) return writeActionCta('subscribe', input.role, input.billingHref)
  if (input.role == null) return { kind: 'go_to_billing', href: input.billingHref }
  if (!isPlatformOrgAdmin(input.role)) return { kind: 'ask_admin', href: input.billingHref }
  if (input.hasPaymentMethod === true) return { kind: 'topup', href: input.billingHref }
  if (input.hasPaymentMethod === false) return { kind: 'add_card', href: input.billingHref }
  return { kind: 'go_to_billing', href: input.billingHref }
}

// ---------------------------------------------------------------------------
// Billing state (hooks)
// ---------------------------------------------------------------------------

const BILLING_QUERY_KEY = ['platform-billing'] as const

interface PaywallBilling {
  cta: PaywallCta | null
  loading: boolean
  /** Proxy gate re-allowed access after this paywall appeared: the card can clear. */
  cleared: boolean
}

// Refetch billing on the dashboard hand-back deep link and on window focus,
// coalesced. Lives with the paywall so it only runs while one is on screen.
function useBillingRefreshSignals(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const run = () => {
      void queryClient
        .invalidateQueries({ queryKey: BILLING_QUERY_KEY, refetchType: 'active' })
        .catch((error: unknown) => {
          console.warn('[Paywall] billing refresh failed:', error)
          captureRendererException(error, { tags: { area: 'paywall', op: 'refresh-after-update' } })
        })
    }
    let scheduled: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (scheduled !== null) return
      scheduled = setTimeout(() => {
        scheduled = null
        run()
      }, 50)
    }
    const removeElectronListener = window.electronAPI?.onBillingUpdated?.(schedule)
    void window.electronAPI?.flushPendingBillingUpdated?.().then((had) => {
      if (had) schedule()
    })
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (scheduled !== null) clearTimeout(scheduled)
      removeElectronListener?.()
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [queryClient])
}

// `flagFrom402` is the proxy's subscription_required flag when the 402 body kept it.
function usePaywallBilling(flagFrom402: boolean | undefined): PaywallBilling {
  const { data: platformAuth } = usePlatformAuthStatus()
  const role = platformAuth?.role
  const billingQuery = useBillingInfo(Boolean(platformAuth?.connected))
  const queryClient = useQueryClient()

  // A snapshot cached before this paywall appeared may say `allowed: true`
  // from a previous recovery. Only a fetch newer than the paywall can clear it.
  const [seenAt] = useState(() => Date.now())
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: BILLING_QUERY_KEY, refetchType: 'active' })
  }, [queryClient])
  useBillingRefreshSignals()

  const billingError = billingQuery.error
  useEffect(() => {
    if (!billingError) return
    console.warn('[Paywall] billing snapshot fetch failed:', billingError)
    captureRendererException(billingError, { tags: { area: 'paywall', op: 'billing-info' } })
  }, [billingError])

  return useMemo(() => {
    const billingHref = resolveOrgBillingUrl(platformAuth)
    if (billingQuery.isLoading) {
      // Resolve from the 402 flag alone when the snapshot cannot change the answer.
      const canResolveFrom402 = platformAuth !== undefined && (
        flagFrom402 === true
        || (flagFrom402 === false && (role == null || !isPlatformOrgAdmin(role)))
      )
      return {
        cta: canResolveFrom402
          ? resolvePaywallCta({ subscriptionRequired: flagFrom402, role, hasPaymentMethod: undefined, billingHref })
          : null,
        loading: true,
        cleared: false,
      }
    }
    const fresh = billingQuery.data?.stale !== true
    const billing = billingQuery.data?.billing
    return {
      cta: resolvePaywallCta({
        subscriptionRequired: flagFrom402 ?? subscriptionRequiredFromBilling(billing),
        role,
        hasPaymentMethod: billing?.hasPaymentMethod,
        paymentStatus: billing?.subscription.paymentStatus,
        billingHref,
      }),
      loading: false,
      cleared: fresh && billing?.access?.allowed === true && billingQuery.dataUpdatedAt > seenAt,
    }
  }, [
    billingQuery.data?.billing,
    billingQuery.data?.stale,
    billingQuery.dataUpdatedAt,
    billingQuery.isLoading,
    flagFrom402,
    platformAuth,
    role,
    seenAt,
  ])
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// The leading **bold** segment is the title, the rest the subtitle.
function splitMessage(markdown: string): { title: string; body: string } {
  const match = markdown.match(/^\*\*(.+?):?\*\*\s*([\s\S]*)$/)
  if (match) return { title: match[1], body: match[2] }
  return { title: markdown, body: '' }
}

function title(cta: PaywallCta | null, fallback: string): string {
  if (cta?.kind === 'subscribe') return 'Subscribe to keep going'
  if (cta?.kind === 'add_card') return 'Add a payment method'
  if (cta?.kind === 'manage_payment') return 'Payment needs attention'
  if (cta?.kind === 'ask_admin') return 'Workspace billing needs attention'
  return fallback
}

function subtitle(cta: PaywallCta | null, fallback: string): string {
  if (cta?.kind === 'subscribe') return 'Start a subscription to continue using this workspace.'
  if (cta?.kind === 'add_card') return 'Add a payment method before purchasing more usage credit.'
  if (cta?.kind === 'topup') return 'Add usage credit to resume this answer.'
  if (cta?.kind === 'manage_payment') return 'Your payment needs attention before agents can continue.'
  if (cta?.kind === 'ask_admin') return 'Ask a workspace admin to resolve billing for this organization.'
  return fallback
}

const CTA_LABELS: Record<PaywallCta['kind'], string> = {
  subscribe: 'Subscribe',
  add_card: 'Add credit card',
  manage_payment: 'Fix payment',
  go_to_billing: 'Go to billing',
  ask_admin: 'Go to billing',
  topup: 'Add usage',
}

function ctaHref(cta: PaywallCta): string | null {
  if (cta.kind === 'topup') return buildTopupHandoffUrl(cta.href, window.electronAPI?.desktopProtocol)
  return cta.href
}

function PaywallActions({ cta, loading }: { cta: PaywallCta | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="paywall-actions-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading billing options…
      </div>
    )
  }
  if (!cta) return null
  const href = ctaHref(cta)
  return (
    <div data-testid="paywall-actions">
      <Button
        size="sm"
        disabled={!href}
        onClick={(event) => {
          event.stopPropagation()
          if (href) void openExternalUrl(href)
        }}
      >
        {CTA_LABELS[cta.kind]}
      </Button>
    </div>
  )
}

// Platform 402. An invitation, not a failure: neutral card, title + muted
// subtitle, one role/billing-aware CTA. Displaces the composer; hands it
// back once the proxy gate allows access again.
export function PaywallCard({ message, presentation, children }: ProviderErrorComponentProps) {
  const billing = usePaywallBilling(extractSubscriptionRequired(message))
  if (billing.cleared) return <>{children}</>

  const fallback = splitMessage(presentation?.message ?? message)
  const heading = billing.loading ? 'Checking billing' : title(billing.cta, fallback.title)
  const detail = billing.loading ? 'Checking your workspace billing status.' : subtitle(billing.cta, fallback.body)

  return (
    <div className="relative px-4 pb-5">
      <HomeEmptyClouds masked={false} fill={0.6} />
      <div
        data-testid="paywall-card"
        className="relative flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-4 shadow-sm"
      >
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-sm font-medium text-foreground">{heading}</p>
          {detail && <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>}
        </div>
        <PaywallActions cta={billing.cta} loading={billing.loading} />
      </div>
    </div>
  )
}
