import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { extractSubscriptionRequired } from '@shared/lib/llm-provider/platform-error-presentation'
import { cn } from '@shared/lib/utils/cn'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { HomeEmptyClouds } from '@renderer/components/home/home-empty-clouds'
import { Button } from '@renderer/components/ui/button'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { BillingEmbedView } from '@renderer/lib/billing-embed'
import { isElectron } from '@renderer/lib/env'
import { openExternalUrl } from '@renderer/lib/open-external'

import { BillingEmbedFrame, BRAND_BUTTON_CLASS, type SubscribePlan } from './billing-embed-frame'
import { buildTopupHandoffUrl, type PaywallCta } from './platform-paywall-cta'
import type { ProviderErrorComponentProps } from './provider-error-registry'
import { usePlatformPaywallBilling } from './use-platform-paywall-billing'

// The session composer's glass (FLOATING_COMPOSER_CLASS in chat-composer-box.tsx), a touch
// more opaque so the card's copy stays readable over the colour bloom behind it.
const PAYWALL_GLASS_CLASS =
  'border-border/70 bg-background/90 shadow-[0_0_24px_rgba(15,23,42,0.07),0_2px_10px_-4px_rgba(15,23,42,0.08)] backdrop-blur-md supports-[backdrop-filter]:bg-background/80 dark:shadow-[0_0_26px_rgba(0,0,0,0.22),0_2px_12px_-4px_rgba(0,0,0,0.16)]'

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
  if (cta?.kind === 'subscribe') return 'An active subscription lets your agents pick this back up.'
  if (cta?.kind === 'add_card') return 'Add a payment method before purchasing more usage credit.'
  if (cta?.kind === 'topup') return 'Add usage credit to resume this answer.'
  if (cta?.kind === 'manage_payment') return 'Your payment needs attention before agents can continue.'
  if (cta?.kind === 'ask_admin') return 'Ask a workspace admin to add usage credit to this organization.'
  return fallback
}

const CTA_LABELS: Record<PaywallCta['kind'], string> = {
  subscribe: 'Upgrade to Pro',
  add_card: 'Add credit card',
  manage_payment: 'Fix payment',
  go_to_billing: 'Go to billing',
  ask_admin: 'Go to billing',
  topup: 'Add usage',
}

// The two CTAs that buy something are brand blue; the rest stay neutral.
const BRAND_CTAS = new Set<PaywallCta['kind']>(['topup', 'subscribe'])

function ctaHref(cta: PaywallCta): string | null {
  if (cta.kind === 'topup') return buildTopupHandoffUrl(cta.href)
  return cta.href
}

// Which chrome-less platform panel each CTA gets. Members (ask_admin) and an
// unknown role (go_to_billing) cannot act on billing, so they keep the button.
const EMBED_VIEW: Record<PaywallCta['kind'], BillingEmbedView | undefined> = {
  topup: 'topup',
  add_card: 'topup',
  subscribe: 'subscribe',
  manage_payment: 'payment',
  ask_admin: undefined,
  go_to_billing: undefined,
}

// Keep in sync with the platform plan card's PRO_FEATURES; this is the three-line
// version for a card that interrupts a running session.
const PRO_BENEFITS = [
  'Unlimited agents, agentic apps and account connections',
  'Team cloud + private desktop workspaces',
  '$200 of monthly usage included per seat. Pay-as-you-go past that.',
]

function formatDollars(cents: number): string {
  const whole = cents % 100 === 0
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`
}

function PaywallActions({
  cta,
  loading,
  handedOff,
  expanded,
  stretch,
  dismissible,
  embeddedAction,
  onDismiss,
  onHandOff,
  onRecheck,
}: {
  cta: PaywallCta | null
  loading: boolean
  handedOff: boolean
  // The embedded frame is showing a panel: give it the full row, Dismiss drops below it.
  expanded: boolean
  // Fill the column (the subscribe price block) instead of hugging the right edge.
  stretch?: boolean
  dismissible: boolean
  embeddedAction: ReactNode
  onDismiss: (ctaKind: string) => void
  onHandOff: (ctaKind: string) => void
  onRecheck: (ctaKind: string) => void
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="paywall-actions-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading billing options…
      </div>
    )
  }
  const href = cta ? ctaHref(cta) : null
  const ctaKind = cta?.kind ?? 'none'
  const brand = cta ? BRAND_CTAS.has(cta.kind) : false
  return (
    <div
      className={cn('flex gap-2', expanded ? 'basis-full flex-col items-stretch' : stretch ? 'w-full items-stretch' : 'items-end')}
      data-testid="paywall-actions"
      data-expanded={expanded}
    >
      {dismissible && (
        <Button size="sm" variant="ghost" className={expanded ? 'order-last self-end' : undefined} onClick={() => onDismiss(ctaKind)}>
          Dismiss
        </Button>
      )}
      {handedOff ? (
        <Button
          size="sm"
          className={stretch ? 'flex-1' : undefined}
          onClick={(event) => {
            event.stopPropagation()
            onRecheck(ctaKind)
          }}
        >
          Recheck
        </Button>
      ) : embeddedAction ?? (cta ? (
        <Button
          size="sm"
          className={cn(brand && BRAND_BUTTON_CLASS, stretch && 'flex-1')}
          disabled={!href}
          onClick={(event) => {
            event.stopPropagation()
            if (!href) return
            void openExternalUrl(href)
            onHandOff(ctaKind)
          }}
        >
          {CTA_LABELS[cta.kind]}
          {cta.kind === 'subscribe' && <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
        </Button>
      ) : null)}
    </div>
  )
}

// The subscribe card: why to upgrade on the left, the quote and the action on the right.
// The quote comes from the platform CTA (seat count and per-seat price it will bill), so
// it is absent until that arrives and on Electron, where the CTA opens the browser.
function SubscribeBody({ plan, hint, actions }: { plan: SubscribePlan | null; hint: string; actions: ReactNode }) {
  return (
    <div className="flex items-center gap-6 py-1.5" data-testid="paywall-subscribe">
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium leading-6 text-muted-foreground">Your trial has ended.</p>
        <p className="text-base font-medium leading-6 text-foreground">Upgrade to Pro to keep going.</p>
        <ul className="mt-4 flex flex-col gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
          {PRO_BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
              {benefit}
            </li>
          ))}
        </ul>
        {hint && <p className="mt-3 text-[11px] leading-4 text-muted-foreground" data-testid="billing-cta-hint">{hint}</p>}
      </div>
      <div className="flex min-w-[200px] shrink-0 flex-col items-start justify-center gap-3 self-stretch border-l border-border/70 py-1 pl-10 pr-3">
        {plan && (
          <div data-testid="paywall-plan">
            <p className="text-xl font-medium leading-6 text-foreground">
              {formatDollars(plan.seats * plan.seatPriceCents)}
              <span className="text-sm font-normal leading-[18px] text-muted-foreground">/mo</span>
            </p>
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              <span className="text-foreground">{plan.seats} {plan.seats === 1 ? 'seat' : 'seats'}</span>
              <span className="mx-2 text-sm leading-none">×</span>
              {formatDollars(plan.seatPriceCents)}/mo
            </p>
          </div>
        )}
        {actions}
      </div>
    </div>
  )
}

// Platform 402. An invitation, not a failure: neutral card, title + muted subtitle, one
// role/billing-aware CTA. Fails open: the composer is withheld only while a fresh billing
// snapshot positively denies access; otherwise the card sits above it.
export function PlatformPaywallCard({ message, presentation, children, live = true, dismissible = false }: ProviderErrorComponentProps) {
  const [dismissed, setDismissed] = useState(false)
  const [handedOff, setHandedOff] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [ctaHint, setCtaHint] = useState('')
  const [plan, setPlan] = useState<SubscribePlan | null>(null)
  const billingChanged = useRef(false)
  const successShown = useRef(false)
  const { data: platformAuth } = usePlatformAuthStatus()
  const { track } = useAnalyticsTracking()
  const billing = usePlatformPaywallBilling(
    extractSubscriptionRequired(message),
    presentation?.href ?? null,
    live,
    !dismissed,
  )
  // Electron keeps the system-browser hand-off. Web on a cloud workspace (the
  // only place the platform will frame its billing page) embeds it in-app.
  const inApp = !isElectron() && platformAuth?.platformControlled === true
  const view = billing.cta ? EMBED_VIEW[billing.cta.kind] : undefined
  const embedded = inApp && view !== undefined
  const { recheck } = billing
  const handleBillingUpdated = useCallback(() => {
    billingChanged.current = true
    recheck()
  }, [recheck])
  const collapse = useCallback(() => setExpanded(false), [])
  // Only the top-up panel expands in place; a view change remounts the frame anyway.
  useEffect(() => {
    if (expanded && view !== 'topup') setExpanded(false)
  }, [expanded, view])
  useEffect(() => {
    if (!billing.cleared || !inApp || !billingChanged.current || successShown.current) return
    successShown.current = true
    toast.success('Billing updated. You can continue.')
  }, [billing.cleared, inApp])

  const ctaKind = billing.cta?.kind ?? 'none'
  const shownRef = useRef(false)
  useEffect(() => {
    if (shownRef.current || billing.loading || billing.cleared || dismissed) return
    shownRef.current = true
    track('paywall_shown', { ctaKind, blocked: billing.blocked, placement: presentation?.placement ?? 'unknown' })
  }, [billing.loading, billing.cleared, billing.blocked, dismissed, ctaKind, presentation?.placement, track])
  useEffect(() => {
    if (!shownRef.current || !billing.cleared) return
    track('paywall_cleared', { ctaKind, handedOff })
  }, [billing.cleared, ctaKind, handedOff, track])

  if (billing.cleared || dismissed) return <>{children}</>

  const fallback = splitMessage(presentation?.message ?? message)
  const panelOpen = embedded && expanded
  const subscribeLayout = billing.cta?.kind === 'subscribe'
  const heading = billing.loading ? 'Checking billing' : title(billing.cta, fallback.title)
  const detail = billing.loading ? 'Checking your workspace billing status.' : subtitle(billing.cta, fallback.body)
  const hint = embedded && !panelOpen ? ctaHint : ''
  const showHeader = !panelOpen && Boolean(heading || detail || hint)

  const actions = (
    <PaywallActions
      cta={billing.cta}
      loading={billing.loading}
      handedOff={handedOff}
      expanded={embedded && expanded}
      stretch={subscribeLayout}
      dismissible={dismissible}
      embeddedAction={embedded && billing.cta ? (
        // Keyed by view, not CTA kind: add_card → topup after a card is saved must
        // keep the same iframe document (and its storage-access grant).
        <BillingEmbedFrame
          key={view}
          launcher
          expanded={expanded}
          stretch={subscribeLayout}
          tone={BRAND_CTAS.has(billing.cta.kind) ? 'brand' : 'default'}
          label={CTA_LABELS[billing.cta.kind]}
          onHintChange={setCtaHint}
          onPlanChange={setPlan}
          cta={billing.cta.kind === 'add_card' ? 'add_card' : undefined}
          intent={billing.cta.kind === 'topup' ? 'topup' : undefined}
          view={view}
          orgId={platformAuth?.orgId ?? null}
          platformBaseUrl={platformAuth?.platformBaseUrl ?? null}
          fallbackHref={ctaHref(billing.cta)}
          onBillingUpdated={handleBillingUpdated}
          onOpenBilling={() => setExpanded(true)}
          onClose={collapse}
          onOpenExternal={() => { setExpanded(false); setHandedOff(true) }}
        />
      ) : null}
      onDismiss={(kind) => {
        track('paywall_dismissed', { ctaKind: kind, handedOff })
        setDismissed(true)
      }}
      onHandOff={(kind) => {
        track('paywall_cta_clicked', { ctaKind: kind })
        setHandedOff(true)
      }}
      onRecheck={(kind) => {
        track('paywall_recheck_clicked', { ctaKind: kind })
        billing.recheck()
      }}
    />
  )

  return (
    <>
      <div className={cn('relative px-4', billing.blocked ? 'pb-5' : 'pb-2')}>
        <HomeEmptyClouds masked={false} fill={0.6} />
        <div
          data-testid="paywall-card"
          data-blocked={billing.blocked}
          data-embedded={embedded}
          data-expanded={panelOpen}
          className={cn(
            'relative flex flex-col gap-3 rounded-xl border',
            PAYWALL_GLASS_CLASS,
            subscribeLayout ? 'px-6 py-5' : 'px-5 py-4',
            // West's purchase dialog was max-w-md; keep the collapsed banner full-width.
            panelOpen && 'mx-auto w-full max-w-md',
          )}
        >
          {subscribeLayout ? (
            <SubscribeBody plan={plan} hint={hint} actions={actions} />
          ) : (
            <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-3', !showHeader && 'justify-end')}>
              {showHeader && (
                <div className="min-w-0 flex-1 basis-60">
                  {heading && <p className="text-sm font-medium text-foreground">{heading}</p>}
                  {detail && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{detail}</p>}
                  {hint && <p className="mt-1 text-xs text-muted-foreground" data-testid="billing-cta-hint">{hint}</p>}
                </div>
              )}
              {actions}
            </div>
          )}
        </div>
      </div>
      {!billing.blocked && children}
    </>
  )
}
