import { z } from 'zod'

export const createSecretRequestSchema = z.object({
  key: z.string().default(''),
  value: z.string().default(''),
})

export const updateSecretRequestSchema = z
  .object({
    key: z.string().trim().min(1).optional(),
    value: z.string().min(1).optional(),
  })
  .refine((body) => body.key !== undefined || body.value !== undefined, {
    message: 'At least one field is required',
  })
