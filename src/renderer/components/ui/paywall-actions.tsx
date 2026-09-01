import { useState, type MouseEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import {
  formatTopupDollars,
  MIN_TOPUP_DOLLARS,
  parseCustomTopupDollars,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { openExternalUrl } from '@renderer/lib/open-external'

function stopCardToggle(event: MouseEvent) {
  event.preventDefault()
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
      size="xs"
      variant="outline"
      disabled={disabled || !href}
      onClick={(event) => {
        stopCardToggle(event)
        if (href) void openExternalUrl(href)
      }}
    >
      {children}
    </Button>
  )
}

const CTA_LABELS = {
  subscribe: 'Subscribe',
  add_card: 'Add credit card',
  go_to_billing: 'Go to billing',
} as const

export function PaywallActions({
  cta,
  loading,
}: {
  cta: PaywallCta | null
  loading: boolean
}) {
  const [customDollars, setCustomDollars] = useState('')

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-xs" data-testid="paywall-actions-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading billing options…
      </div>
    )
  }

  if (!cta || cta.kind === 'billing_link') return null

  if (cta.kind === 'ask_admin') {
    return (
      <p className="mt-2 text-xs" data-testid="paywall-actions">
        Ask a workspace admin to top up this organization.
      </p>
    )
  }

  if (cta.kind === 'subscribe' || cta.kind === 'add_card' || cta.kind === 'go_to_billing') {
    return (
      <div className="mt-2" data-testid="paywall-actions">
        <ExternalCtaButton href={cta.href}>{CTA_LABELS[cta.kind]}</ExternalCtaButton>
      </div>
    )
  }

  const customAmount = parseCustomTopupDollars(customDollars)

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="paywall-actions">
      {cta.amountsCents.map((cents) => (
        <ExternalCtaButton key={cents} href={cta.href}>
          {formatTopupDollars(cents)}
        </ExternalCtaButton>
      ))}
      <Input
        type="number"
        min={MIN_TOPUP_DOLLARS}
        step={1}
        inputMode="numeric"
        placeholder="Custom"
        aria-label={`Custom top-up amount in dollars (minimum $${MIN_TOPUP_DOLLARS})`}
        className="h-7 w-20 px-2 text-xs"
        value={customDollars}
        onClick={stopCardToggle}
        onChange={(event) => setCustomDollars(event.target.value)}
      />
      <ExternalCtaButton href={cta.href} disabled={customAmount === null}>
        Top up
      </ExternalCtaButton>
    </div>
  )
}
