import { useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronRight, CreditCard, Loader2 } from 'lucide-react'

import {
  formatTopupDollars,
  MIN_AUTO_RELOAD_THRESHOLD_DOLLARS,
  MIN_TOPUP_DOLLARS,
  parseAutoReloadThresholdDollars,
  parseCustomTopupDollars,
  type PaywallCta,
} from '@shared/lib/llm-provider/paywall-cta'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { usePaywallBilling } from '@renderer/hooks/use-paywall-billing'
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

function DollarInput({
  value,
  onChange,
  min = MIN_TOPUP_DOLLARS,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  min?: number
  'aria-label': string
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        $
      </span>
      <Input
        type="number"
        min={min}
        step={1}
        inputMode="numeric"
        aria-label={ariaLabel}
        className="pl-7 text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

// The billing snapshot doesn't expose card details yet, so the row names the
// card generically; Change opens the org billing page.
function PaymentMethodRow({ href }: { href: string | null }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">Payment method</p>
      <div className="mt-1.5 flex items-center gap-2.5 rounded-lg border px-3 py-2.5">
        <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 text-sm">Card on file</span>
        <Button
          variant="ghost"
          size="xs"
          className="gap-0.5 text-muted-foreground"
          disabled={!href}
          onClick={(event) => {
            stopCardToggle(event)
            if (href) void openExternalUrl(href)
          }}
        >
          Change
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

function SummaryRows({ dollars }: { dollars: number | null }) {
  const total = dollars === null ? '$0.00' : `$${dollars}.00`
  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-between text-muted-foreground">
        <span>Subtotal</span>
        <span>{total}</span>
      </div>
      <div className="flex justify-between text-muted-foreground">
        <span>Estimated tax</span>
        <span>$0.00</span>
      </div>
      <div className="flex justify-between font-medium">
        <span>Total due today</span>
        <span>{total}</span>
      </div>
    </div>
  )
}

// One-time Purchase still opens org billing. Auto-refill saves in-app
// (no charge today — billing charges when the pool drops below the threshold).
function TopupDialog({
  href,
  amountsCents,
}: {
  href: string | null
  amountsCents: readonly number[]
}) {
  const [open, setOpen] = useState(false)
  const [dollarsInput, setDollarsInput] = useState('')
  const [thresholdDollars, setThresholdDollars] = useState('50')
  const [refillDollars, setRefillDollars] = useState('200')
  const [agreed, setAgreed] = useState(false)
  const { setAutoReload, pending, error } = usePaywallBilling()

  const onceDollars = parseCustomTopupDollars(dollarsInput)
  const refillAmount = parseCustomTopupDollars(refillDollars)
  const thresholdAmount = parseAutoReloadThresholdDollars(thresholdDollars)
  const canSaveAutoReload = agreed
    && refillAmount !== null
    && thresholdAmount !== null
    && refillAmount > thresholdAmount

  const purchase = () => {
    if (href) void openExternalUrl(href)
    setOpen(false)
  }

  const saveAutoReload = async () => {
    if (thresholdAmount === null || refillAmount === null) return
    const saved = await setAutoReload({
      enabled: true,
      thresholdCents: thresholdAmount * 100,
      topupAmountCents: refillAmount * 100,
    })
    if (saved) setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setDollarsInput('')
          setAgreed(false)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" onClick={stopCardToggle}>
          Add usage
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" onClick={stopCardToggle}>
        <DialogHeader>
          <DialogTitle>Add more usage credit</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="once">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="refill">Auto-refill</TabsTrigger>
            <TabsTrigger value="once">One-time purchase</TabsTrigger>
          </TabsList>

          <TabsContent value="once" className="mt-4 space-y-4">
            <div className="space-y-2">
              <DollarInput
                value={dollarsInput}
                onChange={setDollarsInput}
                aria-label={`Amount in dollars (minimum $${MIN_TOPUP_DOLLARS})`}
              />
              <div className="grid grid-cols-4 gap-2">
                {amountsCents.map((cents) => (
                  <Button
                    key={cents}
                    variant="outline"
                    onClick={() => setDollarsInput(String(cents / 100))}
                  >
                    {formatTopupDollars(cents)}
                  </Button>
                ))}
              </div>
            </div>
            <Separator />
            <PaymentMethodRow href={href} />
            <Separator />
            <SummaryRows dollars={onceDollars} />
            <Button
              className="w-full"
              disabled={onceDollars === null || !href}
              onClick={purchase}
            >
              Purchase
            </Button>
          </TabsContent>

          <TabsContent value="refill" className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">Auto-refill when balance drops below</p>
              <DollarInput
                value={thresholdDollars}
                onChange={setThresholdDollars}
                min={MIN_AUTO_RELOAD_THRESHOLD_DOLLARS}
                aria-label="Balance threshold in dollars"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground">
                Amount to refill when balance drops below ${thresholdAmount ?? '…'}
              </p>
              <DollarInput
                value={refillDollars}
                onChange={setRefillDollars}
                aria-label="Auto-refill amount in dollars"
              />
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                disabled={!href}
                onClick={(event) => {
                  stopCardToggle(event)
                  if (href) void openExternalUrl(href)
                }}
              >
                Go to billing to manage spend limits
              </button>
            </div>
            <Separator />
            <PaymentMethodRow href={href} />
            <Separator />
            <SummaryRows dollars={refillAmount} />
            <label className="flex items-center gap-2.5 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <Checkbox
                checked={agreed}
                onCheckedChange={(checked) => setAgreed(checked === true)}
              />
              <span>
                You agree that your organization will charge this payment method
                whenever the balance falls below ${thresholdAmount ?? '…'}.
                To cancel, turn off auto-refill.
              </span>
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button
              className="w-full"
              disabled={!canSaveAutoReload || pending}
              onClick={() => void saveAutoReload()}
            >
              {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Save auto-refill
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// Renders into the right-hand slot of the paywall card.
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

  // Non-admins can't top up, but they can still see the billing page.
  if (cta.kind === 'ask_admin') {
    return (
      <div data-testid="paywall-actions">
        <ExternalCtaButton href={cta.href}>Go to billing</ExternalCtaButton>
      </div>
    )
  }

  if (cta.kind === 'topup') {
    return (
      <div data-testid="paywall-actions">
        <TopupDialog href={cta.href} amountsCents={cta.amountsCents} />
      </div>
    )
  }

  return (
    <div data-testid="paywall-actions">
      <ExternalCtaButton href={cta.href}>{CTA_LABELS[cta.kind]}</ExternalCtaButton>
    </div>
  )
}
