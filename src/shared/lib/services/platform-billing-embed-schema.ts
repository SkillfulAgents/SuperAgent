import { z } from 'zod'

// Renderer-safe half of the billing-embed contract: no auth / Node imports.

export type BillingEmbedErrorCode = 'not_available' | 'reconnect' | 'forbidden' | 'platform_error'

// One chrome-less platform panel per paywall CTA (mirrors the platform's EMBED_VIEWS).
export const BILLING_EMBED_VIEWS = ['topup', 'subscribe', 'payment'] as const
export type BillingEmbedView = (typeof BILLING_EMBED_VIEWS)[number]
export function parseBillingEmbedView(value: unknown): BillingEmbedView | undefined {
  return BILLING_EMBED_VIEWS.find((v) => v === value)
}

export const billingEmbedSessionSchema = z.object({
  /** One-time URL to load in the iframe; boots the partitioned platform session. */
  embedUrl: z.string().url(),
  /** Origin the renderer must accept `message` events from. */
  platformOrigin: z.string().url(),
})
export type BillingEmbedSession = z.infer<typeof billingEmbedSessionSchema>
