import { useMutation } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import {
  billingEmbedSessionSchema,
  type BillingEmbedErrorCode,
  type BillingEmbedSession,
  type BillingEmbedView,
} from '@shared/lib/services/platform-billing-embed-schema'

export type { BillingEmbedSession, BillingEmbedView }

export class BillingEmbedRequestError extends Error {
  constructor(
    message: string,
    readonly code: BillingEmbedErrorCode | 'unknown',
  ) {
    super(message)
    this.name = 'BillingEmbedRequestError'
  }
}

// Each call mints a fresh one-time embed URL, so this is a mutation, not a query.
export function useBillingEmbedSession() {
  return useMutation<
    BillingEmbedSession,
    BillingEmbedRequestError,
    { intent?: 'topup'; view?: BillingEmbedView }
  >({
    mutationFn: async ({ intent, view }) => {
      const res = await apiFetch('/api/platform-auth/billing-embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent, view }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: BillingEmbedErrorCode }
        throw new BillingEmbedRequestError(body.error || 'Could not open billing.', body.code ?? 'unknown')
      }
      const parsed = billingEmbedSessionSchema.safeParse(await res.json().catch(() => null))
      if (!parsed.success) {
        throw new BillingEmbedRequestError('Could not open billing.', 'unknown')
      }
      return parsed.data
    },
  })
}
