import { useMutation } from '@tanstack/react-query'

import { apiFetch } from '@renderer/lib/api'
import type { BillingEmbedErrorCode, BillingEmbedSession } from '@shared/lib/services/platform-billing-embed-service'

export type { BillingEmbedSession }

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
  return useMutation<BillingEmbedSession, BillingEmbedRequestError, { intent?: 'topup' }>({
    mutationFn: async ({ intent }) => {
      const res = await apiFetch('/api/platform-auth/billing-embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: BillingEmbedErrorCode }
        throw new BillingEmbedRequestError(body.error || 'Could not open billing.', body.code ?? 'unknown')
      }
      return res.json()
    },
  })
}
