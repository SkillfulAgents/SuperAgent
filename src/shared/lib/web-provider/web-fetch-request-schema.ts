import { z } from 'zod'

// Zod-at-the-boundary for the container -> host web fetch RPC. The in-container tool is untrusted
// input, so the host validates the body before dispatching to the active vendor. `url` must be a
// well-formed http(s) URL: the scheme guard rejects file:/data:/javascript: etc. at the boundary so
// no non-web scheme (whose empty authority also slips a blocklist-only policy) reaches the vendor.
const isHttpUrl = (u: string): boolean => {
  try {
    const proto = new URL(u).protocol
    return proto === 'http:' || proto === 'https:'
  } catch {
    return false
  }
}

export const WebFetchRequestSchema = z.object({
  url: z.string().url().max(2000).refine(isHttpUrl, { message: 'Only http(s) URLs are supported' }),
  maxChars: z.number().int().positive().optional(),
})

export type WebFetchRequest = z.infer<typeof WebFetchRequestSchema>
