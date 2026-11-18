import { z } from 'zod'

export const protectedResourceMetadataSchema = z.object({
  resource: z.string().url().optional(),
  authorization_servers: z.array(z.string().url()).min(1),
  scopes_supported: z.array(z.string()).optional(),
})
