import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  DASHBOARD_DISPATCH_ACK_TYPE,
  DASHBOARD_DISPATCH_REQUEST_TYPE,
  DASHBOARD_DISPATCH_RESULT_TYPE,
  dashboardDispatchRequestSchema,
  type DashboardDispatchResult,
} from '@shared/lib/dashboard-dispatch-schema'

/**
 * Host side of the dashboard session-dispatch protocol
 * (see `@shared/lib/dashboard-dispatch-schema`).
 *
 * Listens for dispatch requests posted by THIS view's iframe, surfaces at most
 * one at a time as `pending` (the confirmation dialog), and posts the result
 * back. The throttle lives here, not in the dashboard: a request while one is
 * open is refused as `busy`, and for a short cooldown after any resolution as
 * `rate_limited` — so a buggy dashboard loop can at worst re-open one dialog,
 * never stack them or create sessions on its own.
 */

/** Cooldown after a dialog resolves before the next request is accepted. */
export const DASHBOARD_DISPATCH_COOLDOWN_MS = 2000

export interface PendingDashboardDispatch {
  id: string
  prompt: string
  title?: string
}

export function useDashboardDispatch(iframeRef: RefObject<HTMLIFrameElement | null>) {
  const [pending, setPending] = useState<PendingDashboardDispatch | null>(null)
  const pendingRef = useRef<PendingDashboardDispatch | null>(null)
  const cooldownUntilRef = useRef(0)

  const postToDashboard = useCallback(
    (message: Record<string, unknown>) => {
      const frame = iframeRef.current
      if (!frame?.contentWindow) return
      // The iframe origin is the API origin, which differs from the renderer
      // origin in Electron — target it explicitly rather than '*'.
      let targetOrigin: string
      try {
        targetOrigin = new URL(frame.src, window.location.href).origin
      } catch {
        return
      }
      frame.contentWindow.postMessage(message, targetOrigin)
    },
    [iframeRef],
  )

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current
      // Trust the window identity, not the origin: the API origin is shared
      // by every dashboard (and the whole app in web deployments).
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return

      const data: unknown = event.data
      if (
        typeof data !== 'object'
        || data === null
        || (data as { type?: unknown }).type !== DASHBOARD_DISPATCH_REQUEST_TYPE
      ) {
        return
      }

      const parsed = dashboardDispatchRequestSchema.safeParse(data)
      const rawId = (data as { id?: unknown }).id
      if (!parsed.success) {
        if (typeof rawId === 'string' && rawId) {
          postToDashboard({
            type: DASHBOARD_DISPATCH_ACK_TYPE,
            id: rawId,
          })
          postToDashboard({
            type: DASHBOARD_DISPATCH_RESULT_TYPE,
            id: rawId,
            result: {
              error: 'Invalid dispatch request',
              code: 'invalid_request',
            } satisfies DashboardDispatchResult,
          })
        }
        return
      }

      const { id, payload } = parsed.data
      // Always ack a well-formed request so the shim knows a host is
      // listening, even when the request itself is refused below.
      postToDashboard({ type: DASHBOARD_DISPATCH_ACK_TYPE, id })

      if (pendingRef.current) {
        postToDashboard({
          type: DASHBOARD_DISPATCH_RESULT_TYPE,
          id,
          result: {
            error: 'A dispatch request is already awaiting the user',
            code: 'busy',
          } satisfies DashboardDispatchResult,
        })
        return
      }
      if (Date.now() < cooldownUntilRef.current) {
        postToDashboard({
          type: DASHBOARD_DISPATCH_RESULT_TYPE,
          id,
          result: {
            error: 'Dispatch requests are rate limited — wait for the user',
            code: 'rate_limited',
          } satisfies DashboardDispatchResult,
        })
        return
      }

      const next: PendingDashboardDispatch = {
        id,
        prompt: payload.prompt,
        title: payload.title,
      }
      pendingRef.current = next
      setPending(next)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [iframeRef, postToDashboard])

  const resolvePending = useCallback(
    (result: DashboardDispatchResult) => {
      const current = pendingRef.current
      if (!current) return
      pendingRef.current = null
      cooldownUntilRef.current = Date.now() + DASHBOARD_DISPATCH_COOLDOWN_MS
      setPending(null)
      postToDashboard({
        type: DASHBOARD_DISPATCH_RESULT_TYPE,
        id: current.id,
        result,
      })
    },
    [postToDashboard],
  )

  return { pending, resolvePending }
}
