import { z } from 'zod'

/**
 * What an agent may suggest for its owner's setup form. Credentials are never
 * among them: the owner enters those in the app, so they stay out of the
 * request payload clients receive.
 */
export const ownerSetupPrefillSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  localPart: z.string().trim().min(1).max(64).optional(),
  organization: z.string().trim().min(1).max(100).optional(),
})
export type OwnerSetupPrefill = z.infer<typeof ownerSetupPrefillSchema>
