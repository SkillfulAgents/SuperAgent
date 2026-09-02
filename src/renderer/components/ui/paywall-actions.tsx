import { type MouseEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import {
  buildTopupHandoffUrl,
  isArmablePaywallCta,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { Button } from '@renderer/components/ui/button'
import {
  rememberBillingResumeTarget,
  type BillingResumeTarget,
} from '@renderer/lib/billing-resume-target'

export type PaywallResumeTarget = Pick<BillingResumeTarget, 'agentSlug' | 'sessionId'> & {
  initialAllowed?: boolean
}
import { openExternalUrl } from '@renderer/lib/open-external'

function stopCardToggle(event: MouseEvent) {
  event.stopPropagation()
}

function armResume(resumeTarget?: PaywallResumeTarget): void {
  if (!resumeTarget) return
  rememberBillingResumeTarget(resumeTarget)
}

function ExternalCtaButton({
  href,
  disabled,
  onOpen,
  children,
}: {
  href: string | null
  disabled?: boolean
  onOpen?: () => void
  children: ReactNode
}) {
  return (
    <Button
      size="sm"
      disabled={disabled || !href}
      onClick={(event) => {
        stopCardToggle(event)
        if (!href) return
        onOpen?.()
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
  resumeTarget,
}: {
  cta: PaywallCta | null
  loading: boolean
  resumeTarget?: PaywallResumeTarget
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

  const arm = isArmablePaywallCta(cta.kind) ? () => armResume(resumeTarget) : undefined

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
            arm?.()
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
      <ExternalCtaButton href={cta.href} onOpen={arm}>{CTA_LABELS[cta.kind]}</ExternalCtaButton>
    </div>
  )
}
