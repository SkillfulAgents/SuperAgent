import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { extractSubscriptionRequired } from '@shared/lib/llm-provider/platform-error-presentation'
import { cn } from '@shared/lib/utils/cn'
import { HomeEmptyClouds } from '@renderer/components/home/home-empty-clouds'
import { Button } from '@renderer/components/ui/button'
import { openExternalUrl } from '@renderer/lib/open-external'

import { buildTopupHandoffUrl, type PaywallCta } from './paywall-cta'
import type { ProviderErrorComponentProps } from './provider-error-registry'
import { usePaywallBilling } from './use-paywall-billing'

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

function PaywallActions({
  cta,
  loading,
  handedOff,
  onDismiss,
  onHandOff,
  onRecheck,
}: {
  cta: PaywallCta | null
  loading: boolean
  handedOff: boolean
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
      ) : cta ? (
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
      ) : null}
    </div>
  )
}

// Platform 402. An invitation, not a failure: neutral card, title + muted subtitle, one
// role/billing-aware CTA. Fails open: the composer is withheld only while a fresh billing
// snapshot positively denies access; otherwise the card sits above it. Dismiss always works.
export function PaywallCard({ message, presentation, children, live = true }: ProviderErrorComponentProps) {
  const [dismissed, setDismissed] = useState(false)
  const [handedOff, setHandedOff] = useState(false)
  const billing = usePaywallBilling(extractSubscriptionRequired(message), live, !dismissed)
  if (billing.cleared || dismissed) return <>{children}</>

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
          className="relative flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-5 py-4 shadow-sm"
        >
          <div className="min-w-0 flex-1 basis-60">
            <p className="text-sm font-medium text-foreground">{heading}</p>
            {detail && <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>}
          </div>
          <PaywallActions
            cta={billing.cta}
            loading={billing.loading}
            handedOff={handedOff}
            onDismiss={() => setDismissed(true)}
            onHandOff={() => setHandedOff(true)}
            onRecheck={billing.recheck}
          />
        </div>
      </div>
      {!billing.blocked && children}
    </>
  )
}
