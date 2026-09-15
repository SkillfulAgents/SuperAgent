import { z } from 'zod'

export const LinkResponseSchema = z.object({
  link_token: z.string(),
  redirect_url: z.string(),
  expires_at: z.string(),
  connected_account_id: z.string(),
})

export type LinkResponse = z.infer<typeof LinkResponseSchema>

// `POST /connected_accounts` (kept for custom auth configs) answers with the
// account id and the provider's authorize URL.
export const CreateResponseSchema = z.object({
  id: z.string(),
  redirect_url: z.string(),
})
