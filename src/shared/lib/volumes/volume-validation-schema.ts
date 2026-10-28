import { z } from 'zod'

export const volumeValidationSchema = z.object({
  valid: z.boolean(),
  checks: z.array(z.object({ label: z.string(), status: z.enum(['passed', 'failed', 'skipped']), message: z.string().optional() })),
  warnings: z.array(z.string()),
})
export type VolumeValidation = z.infer<typeof volumeValidationSchema>
