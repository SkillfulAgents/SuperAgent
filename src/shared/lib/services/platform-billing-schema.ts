import { z } from 'zod'

import { MAX_TOPUP_DOLLARS, MIN_TOPUP_DOLLARS } from '@shared/lib/llm-provider/paywall-cta'

export const PlatformTopupRequestSchema = z.object({
  amountCents: z
    .number()
    .int()
    .min(MIN_TOPUP_DOLLARS * 100)
    .max(MAX_TOPUP_DOLLARS * 100),
})

export const PlatformTopupResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('complete'),
    amountCents: z.number(),
    alreadyIssued: z.boolean(),
  }),
  z.object({
    status: z.literal('requires_action'),
    paymentIntentId: z.string(),
    clientSecret: z.string(),
    publishableKey: z.string().optional(),
  }),
])

export const PlatformPaymentMethodSetupSchema = z.object({
  clientSecret: z.string().min(1),
  publishableKey: z.string().min(1),
})

export const PlatformPaymentMethodConfirmRequestSchema = z.object({
  paymentMethodId: z.string().trim().min(1),
})

export const PlatformPaymentMethodConfirmResponseSchema = z.object({
  status: z.literal('updated'),
  last4: z.string().nullable(),
  brand: z.string().nullable(),
})

export const PlatformAutoReloadRequestSchema = z.discriminatedUnion('enabled', [
  z.object({
    enabled: z.literal(true),
    thresholdCents: z.number().int().min(100).max(500_000),
    topupAmountCents: z.number().int().min(MIN_TOPUP_DOLLARS * 100).max(MAX_TOPUP_DOLLARS * 100),
  }).refine((value) => value.topupAmountCents > value.thresholdCents),
  z.object({
    enabled: z.literal(false),
  }),
])

export const PlatformAutoReloadResponseSchema = z.object({
  status: z.literal('updated'),
  enabled: z.boolean(),
  thresholdCents: z.number().nullable(),
  topupAmountCents: z.number().nullable(),
})

export type PlatformTopupRequest = z.infer<typeof PlatformTopupRequestSchema>
export type PlatformTopupResponse = z.infer<typeof PlatformTopupResponseSchema>
export type PlatformPaymentMethodSetup = z.infer<typeof PlatformPaymentMethodSetupSchema>
export type PlatformPaymentMethodConfirmResponse = z.infer<typeof PlatformPaymentMethodConfirmResponseSchema>
export type PlatformAutoReloadRequest = z.infer<typeof PlatformAutoReloadRequestSchema>
export type PlatformAutoReloadResponse = z.infer<typeof PlatformAutoReloadResponseSchema>
