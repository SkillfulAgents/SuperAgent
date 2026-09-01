import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import { captureRendererException } from '@renderer/lib/error-reporting'
import type {
  PlatformPaymentMethodConfirmResponse,
  PlatformPaymentMethodSetup,
  PlatformTopupResponse,
} from '@shared/lib/services/platform-billing-schema'

async function readApiError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string } | null
  return typeof body?.error === 'string' && body.error.trim() ? body.error : fallback
}

async function confirmCardPayment(clientSecret: string, publishableKey: string): Promise<void> {
  const { loadStripe } = await import('@stripe/stripe-js')
  const stripe = await loadStripe(publishableKey)
  if (!stripe) throw new Error('Could not load Stripe.')
  const result = await stripe.confirmCardPayment(clientSecret)
  if (result.error) throw new Error(result.error.message ?? 'Card verification failed.')
}

export function usePaywallBilling() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshBilling = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: ['platform-billing'] })
  }, [queryClient])

  const topup = useCallback(async (amountCents: number): Promise<boolean> => {
    setPending(true)
    setError(null)
    try {
      const res = await apiFetch('/api/platform-auth/billing/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents }),
      })
      if (!res.ok) throw new Error(await readApiError(res, 'Could not complete the top-up. Please try again.'))
      const body = (await res.json()) as PlatformTopupResponse
      if (body.status === 'requires_action') {
        if (!body.publishableKey) {
          throw new Error('This card needs extra verification. Please try a different card.')
        }
        await confirmCardPayment(body.clientSecret, body.publishableKey)
      }
      await refreshBilling()
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not complete the top-up. Please try again.'
      setError(message)
      captureRendererException(err, { tags: { area: 'paywall', op: 'topup' } })
      return false
    } finally {
      setPending(false)
    }
  }, [refreshBilling])

  const setupCard = useCallback(async (): Promise<PlatformPaymentMethodSetup | null> => {
    setPending(true)
    setError(null)
    try {
      const res = await apiFetch('/api/platform-auth/billing/payment-method/setup', { method: 'POST' })
      if (!res.ok) throw new Error(await readApiError(res, 'Could not start card setup. Please try again.'))
      return (await res.json()) as PlatformPaymentMethodSetup
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start card setup. Please try again.'
      setError(message)
      captureRendererException(err, { tags: { area: 'paywall', op: 'payment-method-setup' } })
      return null
    } finally {
      setPending(false)
    }
  }, [])

  const confirmCard = useCallback(async (paymentMethodId: string): Promise<PlatformPaymentMethodConfirmResponse | null> => {
    setPending(true)
    setError(null)
    try {
      const res = await apiFetch('/api/platform-auth/billing/payment-method', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId }),
      })
      if (!res.ok) throw new Error(await readApiError(res, 'Could not save this card. Please try again.'))
      const body = (await res.json()) as PlatformPaymentMethodConfirmResponse
      await refreshBilling()
      return body
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save this card. Please try again.'
      setError(message)
      captureRendererException(err, { tags: { area: 'paywall', op: 'payment-method-confirm' } })
      return null
    } finally {
      setPending(false)
    }
  }, [refreshBilling])

  return {
    pending,
    error,
    setError,
    topup,
    setupCard,
    confirmCard,
  }
}
