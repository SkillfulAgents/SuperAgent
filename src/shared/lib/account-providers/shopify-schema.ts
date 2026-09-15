import { z } from 'zod'

// `POST /connected_accounts` answers with the new account's id and the store's
// authorize URL.
export const CreateConnectionResponseSchema = z.object({
  id: z.string(),
  redirect_url: z.string(),
})

// `GET /connected_accounts/:id`: the toolkit and the store the grant is for.
// Platform redacts the token but keeps `subdomain`; `val` is absent on some records.
export const ConnectionStoreSchema = z.object({
  toolkit: z.object({ slug: z.string() }).optional(),
  state: z.object({ val: z.object({ subdomain: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
})
