import { type MouseEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import {
  buildTopupHandoffUrl,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { Button } from '@renderer/components/ui/button'
import { openExternalUrl } from '@renderer/lib/open-external'

function stopCardToggle(event: MouseEvent) {
  event.stopPropagation()
}

function ExternalCtaButton({
  href,
  disabled,
  children,
}: {
  href: string | null
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button
      size="sm"
      disabled={disabled || !href}
      onClick={(event) => {
        stopCardToggle(event)
        if (!href) return
        void openExternalUrl(href)
      }}
    >
      {children}
    </Button>
  )
}

const CTA_LABELS = {
  subscribe: 'Subscribe',
  add_card: 'Add credit card',
  manage_payment: 'Fix payment',
  go_to_billing: 'Go to billing',
} as const

export function PaywallActions({
  cta,
  loading,
}: {
  cta: PaywallCta | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="paywall-actions-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading billing options…
      </div>
    )
  }

  if (!cta) return null

  if (cta.kind === 'ask_admin') {
    return (
      <div data-testid="paywall-actions">
        <ExternalCtaButton href={cta.href}>Go to billing</ExternalCtaButton>
      </div>
    )
  }

  if (cta.kind === 'topup') {
    const handoffHref = buildTopupHandoffUrl(cta.href, window.electronAPI?.desktopProtocol)
    return (
      <div data-testid="paywall-actions">
        <Button
          size="sm"
          disabled={!handoffHref}
          onClick={(event) => {
            stopCardToggle(event)
            if (!handoffHref) return
            void openExternalUrl(handoffHref)
          }}
        >
          Add usage
        </Button>
      </div>
    )
  }

  return (
    <div data-testid="paywall-actions">
      <ExternalCtaButton href={cta.href}>{CTA_LABELS[cta.kind]}</ExternalCtaButton>
    </div>
  )
}
