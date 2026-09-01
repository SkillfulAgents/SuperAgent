import { useEffect, useState } from 'react'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { Loader2 } from 'lucide-react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { usePaywallBilling } from '@renderer/hooks/use-paywall-billing'
import { captureRendererException } from '@renderer/lib/error-reporting'

function CardForm({
  onSaved,
  onCancel,
  confirmCard,
  pending,
}: {
  onSaved: () => void
  onCancel: () => void
  confirmCard: (paymentMethodId: string) => Promise<unknown>
  pending: boolean
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!stripe || !elements) return
    setSubmitting(true)
    setError(null)
    try {
      const confirmed = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
        confirmParams: { return_url: window.location.href },
      })
      if (confirmed.error) {
        setError(confirmed.error.message ?? 'Could not save this card.')
        return
      }
      const paymentMethod = confirmed.setupIntent?.payment_method
      const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id
      if (!paymentMethodId) {
        setError('Stripe did not return a payment method.')
        return
      }
      const saved = await confirmCard(paymentMethodId)
      if (saved) onSaved()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save this card.'
      setError(message)
      captureRendererException(err, { tags: { area: 'paywall', op: 'confirm-setup' } })
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || pending

  return (
    <>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={busy || !stripe} onClick={() => void handleSubmit()}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Save card
        </Button>
      </DialogFooter>
    </>
  )
}

export function AddCardDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { setupCard, confirmCard, pending, error, setError } = usePaywallBilling()
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setStripePromise(null)
      setClientSecret(null)
      setError(null)
      return
    }
    let cancelled = false
    void setupCard().then((setup) => {
      if (cancelled || !setup) return
      setClientSecret(setup.clientSecret)
      setStripePromise(loadStripe(setup.publishableKey))
    })
    return () => {
      cancelled = true
    }
  }, [open, setupCard, setError])

  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" hideClose={pending} onClick={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Add credit card</DialogTitle>
          <DialogDescription>Save a card to top up this workspace without leaving the app.</DialogDescription>
        </DialogHeader>
        {clientSecret && stripePromise ? (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance: { theme: dark ? 'night' : 'stripe' },
            }}
          >
            <CardForm
              pending={pending}
              confirmCard={confirmCard}
              onSaved={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          </Elements>
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            {error ? (
              <p className="text-destructive">{error}</p>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Preparing secure card form…
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
