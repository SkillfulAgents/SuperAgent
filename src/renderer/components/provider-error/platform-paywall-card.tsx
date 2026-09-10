import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
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

import { BillingEmbedFrame } from './billing-embed-frame'
import { buildTopupHandoffUrl, type PaywallCta } from './platform-paywall-cta'
import type { ProviderErrorComponentProps } from './provider-error-registry'
import { usePlatformPaywallBilling } from './use-platform-paywall-billing'

// The leading **bold** segment is the title, the rest the subtitle.
function splitMessage(markdown: string): { title: string; body: string } {
  const match = markdown.match(/^\*\*(.+?):?\*\*\s*([\s\S]*)$/)
  if (match) return { title: match[1], body: match[2] }
  return { title: markdown, body: '' }
}

function title(cta: PaywallCta | null, fallback: string): string {
  if (cta?.kind === 'topup') return ''
  if (cta?.kind === 'subscribe') return 'Subscribe to keep going'
  if (cta?.kind === 'add_card') return 'Add a payment method'
  if (cta?.kind === 'manage_payment') return 'Payment needs attention'
  if (cta?.kind === 'ask_admin') return 'Workspace billing needs attention'
  return fallback
}

function subtitle(cta: PaywallCta | null, fallback: string): string {
  if (cta?.kind === 'topup') return ''
  if (cta?.kind === 'subscribe') return 'An active subscription lets your agents pick this back up.'
  if (cta?.kind === 'add_card') return 'Add a payment method before purchasing more usage credit.'
  if (cta?.kind === 'manage_payment') return 'Your payment needs attention before agents can continue.'
  if (cta?.kind === 'ask_admin') return 'Ask a workspace admin to add usage credit to this organization.'
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

function PaywallActions({
  cta,
  loading,
  handedOff,
  expanded,
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
  return (
    <div className={cn('flex gap-2', expanded ? 'basis-full flex-col items-stretch' : 'items-end')} data-testid="paywall-actions" data-expanded={expanded}>
      {dismissible && (
        <Button size="sm" variant="ghost" className={expanded ? 'order-last self-end' : undefined} onClick={() => onDismiss(ctaKind)}>
          Dismiss
        </Button>
      )}
      {handedOff ? (
        <Button
          size="sm"
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
          disabled={!href}
          onClick={(event) => {
            event.stopPropagation()
            if (!href) return
            void openExternalUrl(href)
            onHandOff(ctaKind)
          }}
        >
          {CTA_LABELS[cta.kind]}
        </Button>
      ) : null)}
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
  const heading = billing.loading ? 'Checking billing' : title(billing.cta, fallback.title)
  const detail = billing.loading ? 'Checking your workspace billing status.' : subtitle(billing.cta, fallback.body)
  const hint = embedded && !panelOpen ? ctaHint : ''
  const showHeader = !panelOpen && Boolean(heading || detail || hint)

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
            'relative flex flex-col gap-3 rounded-xl border bg-card px-5 py-4 shadow-sm',
            // West's purchase dialog was max-w-md; keep the collapsed banner full-width.
            panelOpen && 'mx-auto w-full max-w-md',
          )}
        >
          <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-3', !showHeader && 'justify-end')}>
            {showHeader && (
              <div className="min-w-0 flex-1 basis-60">
                {heading && <p className="text-sm font-medium text-foreground">{heading}</p>}
                {detail && <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>}
                {hint && <p className="mt-1 text-xs text-muted-foreground" data-testid="billing-cta-hint">{hint}</p>}
              </div>
            )}
            <PaywallActions
              cta={billing.cta}
              loading={billing.loading}
              handedOff={handedOff}
              expanded={embedded && expanded}
              dismissible={dismissible}
              embeddedAction={embedded && billing.cta ? (
                // Keyed by view, not CTA kind: add_card → topup after a card is saved must
                // keep the same iframe document (and its storage-access grant).
                <BillingEmbedFrame
                  key={view}
                  launcher
                  expanded={expanded}
                  label={CTA_LABELS[billing.cta.kind]}
                  onHintChange={setCtaHint}
                  cta={billing.cta.kind === 'add_card' ? 'add_card' : undefined}
                  intent={billing.cta.kind === 'topup' ? 'topup' : undefined}
                  view={view}
                  orgId={platformAuth?.orgId ?? null}
                  platformBaseUrl={platformAuth?.platformBaseUrl ?? null}
                  fallbackHref={ctaHref(billing.cta)}
                  onBillingUpdated={handleBillingUpdated}
                  onOpenBilling={() => setExpanded(true)}
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
          </div>
        </div>
      </div>
      {!billing.blocked && children}
    </>
  )
}
