import { z } from 'zod'

// Boundary schemas for the platform's download-nonce endpoints. The code is
// hex so it survives every carrier (installer filename, URL query, xattr).
export const DownloadNonceCodeSchema = z.string().regex(/^[a-f0-9]{40,64}$/)

export const DownloadNonceIdentitySchema = z.object({
  email: z.string().min(1),
  org_name: z.string().optional().default(''),
  role: z.string().optional().default(''),
  // Rendered in an <img src>; anything non-http(s) is dropped at the boundary.
  avatar_url: z
    .string()
    .nullish()
    .transform((v) => (v && /^https?:\/\//.test(v) ? v : null)),
})
export type DownloadNonceIdentity = z.infer<typeof DownloadNonceIdentitySchema>

export const DownloadNonceRedeemResponseSchema = z.object({
  token: z.string().min(1),
  email: z.string().optional().default(''),
  label: z.string().optional().default(''),
  org_id: z.string().optional().default(''),
  org_name: z.string().optional().default(''),
  role: z.string().optional().default(''),
  user_id: z.string().optional().default(''),
  member_id: z.string().optional().default(''),
})
export type DownloadNonceRedeemResponse = z.infer<typeof DownloadNonceRedeemResponseSchema>
