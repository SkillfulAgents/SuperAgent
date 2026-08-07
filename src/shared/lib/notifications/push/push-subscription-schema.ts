import { z } from 'zod'

/**
 * Hosts operated by the browser vendors' push services — the only places a
 * stored endpoint may point. The server later POSTs to every stored endpoint
 * with no client in the loop, so accepting arbitrary URLs here would hand an
 * authenticated user a blind SSRF primitive against loopback/private hosts.
 * Suffix entries cover the vendors' regional/sharded subdomains.
 */
const ALLOWED_PUSH_SERVICE_HOSTS = new Set([
  'web.push.apple.com', // Apple (iOS / macOS Safari) — the v1 target
  'fcm.googleapis.com', // Chrome/Android (classic-SW fallback, future)
  'updates.push.services.mozilla.com', // Firefox (future)
])
const ALLOWED_PUSH_SERVICE_SUFFIXES = [
  '.push.apple.com',
  '.notify.windows.com', // Edge/WNS (future)
]

export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') {
    return false
  }
  const host = url.hostname.toLowerCase()
  return (
    ALLOWED_PUSH_SERVICE_HOSTS.has(host) ||
    ALLOWED_PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
}

/**
 * Wire shape of the client's subscribe call: `PushSubscription.toJSON()` plus
 * device metadata. Validated at the API boundary before anything is stored.
 */
export const pushSubscribeRequestSchema = z.object({
  subscription: z.object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine(isAllowedPushEndpoint, 'Endpoint is not a recognized push service'),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    }),
  }),
  /** Origin the PWA is served from — click-through URLs are built on this. */
  origin: z.string().url().max(512),
  deviceName: z.string().max(128).optional(),
})

export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequestSchema>

export const pushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().url().max(2048),
})
