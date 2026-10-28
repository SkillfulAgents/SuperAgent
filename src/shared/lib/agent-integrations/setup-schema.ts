import { z } from 'zod'
import { INTEGRATION_TRANSPORTS } from './transport'

export const integrationSetupQuerySchema = z.object({ name: z.string().trim().min(1).max(80).optional() })
export const integrationSetupMetadataSchema = z.object({
  /** How the provider can receive events; the host fills this in. */
  transports: z.array(z.enum(INTEGRATION_TRANSPORTS)).optional(),
  agentUserEmails: z.array(z.string().email()).optional(),
  emailDomain: z.string().min(1).optional(),
  creationUrl: z.string().url().optional(),
  redirectUri: z.string().url().optional(),
})
export type IntegrationSetupMetadata = z.infer<typeof integrationSetupMetadataSchema>
