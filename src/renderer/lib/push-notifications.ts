/**
 * Web Push subscription management for the installed PWA (iOS-first).
 *
 * Uses Declarative Web Push (WebKit, iOS/iPadOS 18.4+): `window.pushManager`
 * subscribes without a service worker, and the server's declarative JSON is
 * rendered natively by the OS. Support detection doubles as the platform
 * gate — browsers without `window.pushManager` (all non-WebKit engines as of
 * mid-2026) simply don't see the feature.
 */

import { apiFetch } from './api'
import { isElectron } from './env'

declare global {
  interface Window {
    /** Declarative Web Push surface (WebKit-only). Absent elsewhere. */
    pushManager?: PushManager
  }
}

export function supportsDeclarativeWebPush(): boolean {
  return (
    !isElectron() &&
    typeof window !== 'undefined' &&
    window.pushManager !== undefined &&
    'Notification' in window
  )
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- server-generated base64url VAPID key; subscribe callers surface failures
  const raw = atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i)
  }
  return output
}

function describeThisDevice(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  // iPadOS 13+ masquerades as macOS; a Mac with a touchscreen is an iPad.
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return 'iPad'
  }
  if (/Macintosh/.test(ua)) return 'Mac'
  return 'Browser'
}

async function registerSubscription(subscription: PushSubscription): Promise<void> {
  const res = await apiFetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      origin: window.location.origin,
      deviceName: describeThisDevice(),
    }),
  })
  if (!res.ok) {
    throw new Error(`Failed to register push subscription (${res.status})`)
  }
}

async function fetchVapidPublicKey(): Promise<Uint8Array<ArrayBuffer>> {
  const res = await apiFetch('/api/push/vapid-public-key')
  if (!res.ok) {
    throw new Error(`Failed to fetch VAPID public key (${res.status})`)
  }
  const { publicKey } = (await res.json()) as { publicKey: string }
  return urlBase64ToUint8Array(publicKey)
}

/** Whether an existing subscription was minted against `serverKey`. */
function subscriptionMatchesKey(
  subscription: PushSubscription,
  serverKey: Uint8Array<ArrayBuffer>
): boolean {
  const existingKey = subscription.options.applicationServerKey
  if (!existingKey) return false
  const existing = new Uint8Array(existingKey)
  if (existing.length !== serverKey.length) return false
  return existing.every((byte, i) => byte === serverKey[i])
}

export type PushSubscribeResult = 'subscribed' | 'permission-denied' | 'unsupported'

export async function subscribeThisDevice(): Promise<PushSubscribeResult> {
  if (!supportsDeclarativeWebPush()) return 'unsupported'

  // The permission prompt must be requested synchronously from the tap's
  // call stack (iOS), and subscribe() must follow promptly — so the VAPID key
  // fetch runs CONCURRENTLY with the prompt instead of serializing a network
  // round-trip into WebKit's transient-activation window.
  const serverKeyPromise = fetchVapidPublicKey()
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    serverKeyPromise.catch(() => {}) // don't leak an unhandled rejection
    return 'permission-denied'
  }
  const serverKey = await serverKeyPromise

  // A live subscription bound to a DIFFERENT server key (server keys were
  // regenerated, e.g. factory reset) makes subscribe() reject with
  // InvalidStateError forever — drop it first.
  const existing = await window.pushManager!.getSubscription()
  if (existing && !subscriptionMatchesKey(existing, serverKey)) {
    await existing.unsubscribe()
  }

  const subscription = await window.pushManager!.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  })
  await registerSubscription(subscription)
  return 'subscribed'
}

export async function unsubscribeThisDevice(): Promise<void> {
  if (!supportsDeclarativeWebPush()) return
  const subscription = await window.pushManager!.getSubscription()
  if (!subscription) return

  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  // Best-effort: the server also prunes this row on the next 404/410.
  await apiFetch('/api/push/subscriptions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {})
}

export async function isThisDeviceSubscribed(): Promise<boolean> {
  if (!supportsDeclarativeWebPush()) return false
  if (Notification.permission !== 'granted') return false
  const subscription = await window.pushManager!.getSubscription()
  return subscription !== null
}

/**
 * Re-register the current subscription with the server. Without a service
 * worker there is no `pushsubscriptionchange` event, so a rotated endpoint or
 * a lost server row would silently kill delivery — re-upserting on every
 * launch is the substitute.
 *
 * Key-affinity check first: a subscription minted against a key the server no
 * longer holds (factory reset, restored DB) is permanently undeliverable, and
 * blindly re-upserting it would resurrect the dead row on every launch. Drop
 * it instead; the user re-enables from settings with the current key.
 */
export async function revalidatePushSubscription(): Promise<void> {
  try {
    if (!supportsDeclarativeWebPush()) return
    if (Notification.permission !== 'granted') return
    const subscription = await window.pushManager!.getSubscription()
    if (!subscription) return

    const serverKey = await fetchVapidPublicKey()
    if (!subscriptionMatchesKey(subscription, serverKey)) {
      await subscription.unsubscribe()
      return
    }
    await registerSubscription(subscription)
  } catch {
    // Best-effort — next launch retries.
  }
}
