import { useEffect, useState } from 'react'
import { CircleDollarSign, X } from 'lucide-react'

import { resolvePresentationMarkdown, type ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import {
  resolveOrgBillingUrl,
  resolvePaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { parsePlatformErrorResponse } from '@shared/lib/llm-provider/platform-error-presentation'
import { Button } from '@renderer/components/ui/button'
import {
  setDevPaywallOverride,
  type DevPaywallOverride,
} from '@renderer/components/dev/paywall-dev-override'

// Dev-only toggle strip for the 402 paywall card (SUP-725). Picking a scenario
// stores a forced card in the paywall dev override; AgentActivityIndicator then
// renders it where a live provider error actually appears — at the bottom of
// the open session — so the UI can be iterated on in its real position without
// triggering real 402s. Mounted from App.tsx behind import.meta.env.DEV.

const FAKE_ORG = {
  connected: true,
  platformBaseUrl: 'https://platform.example.com',
  orgId: 'dev-org',
}

const INSUFFICIENT_BODY = { error: { message: 'Insufficient balance: top up to continue.' } }

// Presentations come from the real parser so the panel's copy can't drift
// from what a live 402 would show.
function presentationFor(subscriptionRequired: boolean | undefined): ProviderErrorPresentation {
  const body = subscriptionRequired === undefined
    ? INSUFFICIENT_BODY
    : { ...INSUFFICIENT_BODY, subscription_required: subscriptionRequired }
  const presentation = parsePlatformErrorResponse(402, body)
  if (!presentation) throw new Error('parsePlatformErrorResponse no longer recognizes the dev 402 body')
  return presentation
}

interface Scenario {
  id: string
  label: string
  note: string
  subscriptionRequired: boolean | undefined
  role: string | null
  hasPaymentMethod: boolean | undefined
  loading?: boolean
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'legacy',
    label: 'No flag (legacy)',
    note: 'Proxy omitted subscription_required — plain billing CTA.',
    subscriptionRequired: undefined,
    role: 'owner',
    hasPaymentMethod: undefined,
  },
  {
    id: 'subscribe',
    label: 'Subscribe',
    note: 'subscription_required: true',
    subscriptionRequired: true,
    role: 'member',
    hasPaymentMethod: undefined,
  },
  {
    id: 'ask_admin',
    label: 'Ask admin',
    note: 'flag false, role: member',
    subscriptionRequired: false,
    role: 'member',
    hasPaymentMethod: undefined,
  },
  {
    id: 'go_to_billing',
    label: 'Unknown role',
    note: 'flag false, role: null (settings-backed auth)',
    subscriptionRequired: false,
    role: null,
    hasPaymentMethod: undefined,
  },
  {
    id: 'add_card',
    label: 'Add card',
    note: 'flag false, role: owner, no payment method',
    subscriptionRequired: false,
    role: 'owner',
    hasPaymentMethod: false,
  },
  {
    id: 'topup',
    label: 'Top up',
    note: 'flag false, role: owner, card on file',
    subscriptionRequired: false,
    role: 'owner',
    hasPaymentMethod: true,
  },
  {
    id: 'loading',
    label: 'Loading',
    note: 'billing snapshot fetch in flight',
    subscriptionRequired: false,
    role: 'owner',
    hasPaymentMethod: undefined,
    loading: true,
  },
]

function scenarioCard(scenario: Scenario, orgConnected: boolean): DevPaywallOverride {
  const org = orgConnected ? FAKE_ORG : null
  const presentation = presentationFor(scenario.subscriptionRequired)
  const resolved = {
    ...presentation,
    message: resolvePresentationMarkdown(presentation.message, org),
  }
  if (scenario.loading) {
    return { presentation: resolved, cta: null, loading: true }
  }
  return {
    presentation: resolved,
    cta: resolvePaywallCta({
      subscriptionRequired: scenario.subscriptionRequired,
      role: scenario.role,
      hasPaymentMethod: scenario.hasPaymentMethod,
      billingHref: resolveOrgBillingUrl(org),
    }),
    loading: false,
  }
}

export default function PaywallCtaDevPanel() {
  const [open, setOpen] = useState(() => localStorage.getItem('dev.paywallPanel.open') === '1')
  const [scenarioId, setScenarioId] = useState<string | null>(
    () => localStorage.getItem('dev.paywallPanel.scenario'),
  )
  const [orgConnected, setOrgConnected] = useState(true)

  const active = SCENARIOS.find((scenario) => scenario.id === scenarioId) ?? null

  // The override lives outside React so the injection point (the session's
  // activity indicator) can read it without importing panel machinery. It
  // follows the selected scenario — NOT the panel's open state, so the panel
  // can be collapsed out of the way while iterating on the card. Only the
  // "Off" chip (or unmount) clears it.
  useEffect(() => {
    setDevPaywallOverride(active ? scenarioCard(active, orgConnected) : null)
    return () => setDevPaywallOverride(null)
  }, [active, orgConnected])

  const setOpenPersisted = (next: boolean) => {
    setOpen(next)
    localStorage.setItem('dev.paywallPanel.open', next ? '1' : '0')
  }

  if (!open) {
    return (
      <Button
        size="xs"
        variant={active ? 'secondary' : 'outline'}
        className="fixed bottom-3 right-3 z-50 gap-1.5 opacity-60 hover:opacity-100"
        onClick={() => setOpenPersisted(true)}
        title="Paywall CTA dev panel"
      >
        <CircleDollarSign className="h-3.5 w-3.5" aria-hidden="true" />
        {active ? `402: ${active.label}` : '402'}
      </Button>
    )
  }

  return (
    <div className="fixed bottom-3 right-3 z-50 w-80 rounded-lg border bg-background p-3 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Paywall CTA dev panel</span>
        <Button size="xs" variant="ghost" className="h-6 w-6 p-0" onClick={() => setOpenPersisted(false)} aria-label="Close">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="xs"
          variant={active === null ? 'secondary' : 'ghost'}
          onClick={() => {
            setScenarioId(null)
            localStorage.removeItem('dev.paywallPanel.scenario')
          }}
        >
          Off
        </Button>
        {SCENARIOS.map((scenario) => (
          <Button
            key={scenario.id}
            size="xs"
            variant={scenario.id === active?.id ? 'secondary' : 'ghost'}
            onClick={() => {
              setScenarioId(scenario.id)
              localStorage.setItem('dev.paywallPanel.scenario', scenario.id)
            }}
          >
            {scenario.label}
          </Button>
        ))}
      </div>

      <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={orgConnected}
          onChange={(event) => setOrgConnected(event.target.checked)}
        />
        Platform org connected (billing URL available)
      </label>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {active
          ? `${active.label} — ${active.note} The card renders in the open session, where a live provider error appears.`
          : 'Pick a scenario to force its 402 card into the open session.'}
      </p>
    </div>
  )
}
