import { useState, type MouseEvent } from 'react'
import { Loader2 } from 'lucide-react'

import { formatTopupDollars, type PaywallCta } from '@shared/lib/llm-provider/paywall-cta'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { openExternalUrl } from '@renderer/lib/open-external'

function stopCardToggle(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
}

async function openHref(href: string | null) {
  if (!href) return
  await openExternalUrl(href)
}

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

  if (cta.kind === 'subscribe') {
    return (
      <div className="mt-2" data-testid="paywall-actions">
        <Button
          size="xs"
          variant="outline"
          disabled={!cta.href}
          onClick={(event) => {
            stopCardToggle(event)
            void openHref(cta.href)
          }}
        >
          Subscribe
        </Button>
      </div>
    )
  }

  if (cta.kind === 'add_card') {
    return (
      <div className="mt-2" data-testid="paywall-actions">
        <Button
          size="xs"
          variant="outline"
          disabled={!cta.href}
          onClick={(event) => {
            stopCardToggle(event)
            void openHref(cta.href)
          }}
        >
          Add credit card
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="paywall-actions">
      {cta.amountsCents.map((cents) => (
        <Button
          key={cents}
          size="xs"
          variant="outline"
          disabled={!cta.href}
          onClick={(event) => {
            stopCardToggle(event)
            void openHref(cta.href)
          }}
        >
          {formatTopupDollars(cents)}
        </Button>
      ))}
      <Input
        type="number"
        min={20}
        step={1}
        inputMode="numeric"
        placeholder="Custom"
        aria-label="Custom top-up amount in dollars"
        className="h-7 w-20 px-2 text-xs"
        value={customDollars}
        onClick={stopCardToggle}
        onChange={(event) => setCustomDollars(event.target.value)}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={!cta.href || !customDollars}
        onClick={(event) => {
          stopCardToggle(event)
          void openHref(cta.href)
        }}
      >
        Top up
      </Button>
    </div>
  )
}
