import { z } from 'zod'

export const LinkResponseSchema = z.object({
  link_token: z.string(),
  redirect_url: z.string(),
  expires_at: z.string(),
  connected_account_id: z.string(),
})

export type LinkResponse = z.infer<typeof LinkResponseSchema>
