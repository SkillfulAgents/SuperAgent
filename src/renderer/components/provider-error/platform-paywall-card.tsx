import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'

import { extractSubscriptionRequired } from '@shared/lib/llm-provider/platform-error-presentation'
import { cn } from '@shared/lib/utils/cn'
import { HomeEmptyClouds } from '@renderer/components/home/home-empty-clouds'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
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
  embeddedAction,
  onDismiss,
  onHandOff,
  onRecheck,
}: {
  cta: PaywallCta | null
  loading: boolean
  handedOff: boolean
  embeddedAction: ReactNode
  onDismiss: () => void
  onHandOff: () => void
  onRecheck: () => void
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
  return (
    <div className="flex items-center gap-2" data-testid="paywall-actions">
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
      {handedOff ? (
        <Button
          size="sm"
          onClick={(event) => {
            event.stopPropagation()
            onRecheck()
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
            onHandOff()
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
// snapshot positively denies access; otherwise the card sits above it. Dismiss always works.
export function PlatformPaywallCard({ message, presentation, children, live = true }: ProviderErrorComponentProps) {
  const [dismissed, setDismissed] = useState(false)
  const [handedOff, setHandedOff] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const { data: platformAuth } = usePlatformAuthStatus()
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
  useEffect(() => {
    if (!billing.cleared || !dialogOpen) return
    const timer = setTimeout(() => setDialogOpen(false), 1200)
    return () => clearTimeout(timer)
  }, [billing.cleared, dialogOpen])
  if ((billing.cleared && !dialogOpen) || dismissed) return <>{children}</>

  const fallback = splitMessage(presentation?.message ?? message)
  const heading = billing.loading ? 'Checking billing' : title(billing.cta, fallback.title)
  const detail = billing.loading ? 'Checking your workspace billing status.' : subtitle(billing.cta, fallback.body)

  return (
    <>
      <div className={cn('relative px-4', billing.blocked ? 'pb-5' : 'pb-2')}>
        <HomeEmptyClouds masked={false} fill={0.6} />
        <div
          data-testid="paywall-card"
          data-blocked={billing.blocked}
          data-embedded={embedded}
          ref={cardRef}
          className="relative flex flex-col gap-3 rounded-xl border bg-card px-5 py-4 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1 basis-60">
              <p className="text-sm font-medium text-foreground">{heading}</p>
              {detail && <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>}
            </div>
            <PaywallActions
              cta={billing.cta}
              loading={billing.loading}
              handedOff={handedOff}
              embeddedAction={embedded && billing.cta ? (
                <BillingEmbedFrame
                  key={billing.cta.kind}
                  launcher
                  cta={billing.cta.kind === 'add_card' ? 'add_card' : undefined}
                  intent={billing.cta.kind === 'topup' ? 'topup' : undefined}
                  view={view}
                  orgId={platformAuth?.orgId ?? null}
                  platformBaseUrl={platformAuth?.platformBaseUrl ?? null}
                  fallbackHref={ctaHref(billing.cta)}
                  onBillingUpdated={billing.recheck}
                  onOpenBilling={() => setDialogOpen(true)}
                  onOpenExternal={() => setHandedOff(true)}
                />
              ) : null}
              onDismiss={() => setDismissed(true)}
              onHandOff={() => setHandedOff(true)}
              onRecheck={billing.recheck}
            />
          </div>
          {embedded && billing.cta && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogContent className="flex w-[calc(100%-2rem)] flex-col overflow-hidden sm:max-w-xl" onCloseAutoFocus={(event) => {
                event.preventDefault()
                cardRef.current?.querySelector('iframe')?.focus()
              }}>
                <DialogHeader>
                  <DialogTitle>{billing.cleared ? 'You’re ready to continue' : CTA_LABELS[billing.cta.kind]}</DialogTitle>
                  <DialogDescription>{billing.cleared ? 'Your workspace billing is up to date.' : detail}</DialogDescription>
                </DialogHeader>
                {billing.cleared ? (
                  <div role="status" className="flex items-center gap-2 py-4 text-sm">
                    <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />
                    Billing updated successfully.
                  </div>
                ) : (
                  <BillingEmbedFrame
                    key={view}
                    cta={billing.cta.kind === 'add_card' ? 'add_card' : undefined}
                    intent={billing.cta.kind === 'topup' ? 'topup' : undefined}
                    view={view}
                    orgId={platformAuth?.orgId ?? null}
                    platformBaseUrl={platformAuth?.platformBaseUrl ?? null}
                    fallbackHref={ctaHref(billing.cta)}
                    onBillingUpdated={billing.recheck}
                    onOpenExternal={() => setHandedOff(true)}
                  />
                )}
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
      {!billing.blocked && children}
    </>
  )
}
