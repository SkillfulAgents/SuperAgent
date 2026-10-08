import { z } from 'zod'
import { secretHomeNameSchema } from '@shared/lib/services/secret-connections-schema'

export const createSecretRequestSchema = z.object({
  key: z.string().default(''),
  value: z.string().default(''),
  homeName: secretHomeNameSchema.optional(),
})

export const updateSecretRequestSchema = z
  .object({
    key: z.string().trim().min(1).optional(),
    value: z.string().min(1).optional(),
    /** `null` removes the secret from the agent home. */
    homeName: secretHomeNameSchema.nullable().optional(),
  })
  .refine((body) => body.key !== undefined || body.value !== undefined || body.homeName !== undefined, {
    message: 'At least one field is required',
  })
