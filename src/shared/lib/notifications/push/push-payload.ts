import type { NotificationEvent } from '../notification-event'

/**
 * Declarative Web Push document (WebKit; iOS/iPadOS 18.4+, macOS Safari
 * 18.5+). The browser renders this natively — no service worker runs — and
 * `navigate` is the click-through target, replacing the classic
 * `notificationclick` → `openWindow` dance.
 *
 * Only the spec-stable core is emitted: the `web_push: 8030` marker plus
 * `title` / `body` / `navigate`. Peripheral fields (app_badge, actions,
 * mutable) changed names across drafts and are deliberately omitted.
 */
export function buildDeclarativePushPayload(
  event: NotificationEvent,
  origin: string
): { web_push: 8030; notification: { title: string; body: string; navigate: string } } {
  return {
    web_push: 8030,
    notification: {
      title: event.title,
      body: event.body,
      // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- origin is zod-url-validated at the subscribe boundary; per-subscription failures are isolated in the channel
      navigate: new URL(event.navigatePath, origin).toString(),
    },
  }
}
