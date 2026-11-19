import { useEffect, useRef, type RefObject } from 'react'
import {
  DASHBOARD_HOST_FEATURES_TYPE,
  DASHBOARD_INSPECT_REQUEST_TYPE,
  DASHBOARD_INSPECT_RESULT_TYPE,
  DASHBOARD_CONTEXT_MENU_TYPE,
  dashboardContextMenuSchema,
  dashboardInspectResultSchema,
  type DashboardSnapshot,
} from '@shared/lib/dashboard-inspect-schema'
import { postToDashboardFrame } from '../post-to-dashboard-frame'

/**
 * The app's half of the dashboard inspection protocol
 * (`@shared/lib/dashboard-inspect-schema`): ask the frame for a snapshot, tell
 * it the app takes comments, and hear its right-clicks.
 */

/** A dashboard that answers at all answers at once; one that doesn't never will. */
const INSPECT_TIMEOUT_MS = 1_000

/**
 * What the dashboard page says about itself now: its URL, viewport, selection,
 * console, and the element under `point` (frame CSS pixels). Null when it
 * doesn't answer in time.
 */
export function inspectDashboard(
  frame: HTMLIFrameElement | null,
  point?: { x: number; y: number },
  timeoutMs = INSPECT_TIMEOUT_MS,
): Promise<DashboardSnapshot | null> {
  return new Promise((resolve) => {
    const source = frame?.contentWindow
    if (!source) return resolve(null)
    const id = `inspect-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const finish = (snapshot: DashboardSnapshot | null) => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(snapshot)
    }
    const onMessage = (event: MessageEvent) => {
      // The window, not the origin: every dashboard shares the API's.
      if (event.source !== source) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== DASHBOARD_INSPECT_RESULT_TYPE) return
      if ((data as { id?: unknown }).id !== id) return
      const parsed = dashboardInspectResultSchema.safeParse(data)
      finish(parsed.success ? parsed.data.snapshot : null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    window.addEventListener('message', onMessage)
    const request = point
      ? { type: DASHBOARD_INSPECT_REQUEST_TYPE, id, point: { x: point.x, y: point.y } }
      : { type: DASHBOARD_INSPECT_REQUEST_TYPE, id }
    if (!postToDashboardFrame(frame, request)) finish(null)
  })
}

/**
 * Tells the frame, on each load, whether the app takes comments, and hands
 * each right-click it posts back to `onContextMenu` in frame CSS pixels.
 */
export function useDashboardFrameComments(
  frameRef: RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  onContextMenu: (x: number, y: number) => void,
): { announce: () => void } {
  const latest = useRef({ enabled, onContextMenu })
  useEffect(() => { latest.current = { enabled, onContextMenu } })

  const announce = () => {
    postToDashboardFrame(frameRef.current, { type: DASHBOARD_HOST_FEATURES_TYPE, comments: latest.current.enabled })
  }

  // A change after load (permissions arriving) reaches the frame too.
  useEffect(() => {
    postToDashboardFrame(frameRef.current, { type: DASHBOARD_HOST_FEATURES_TYPE, comments: enabled })
  }, [enabled, frameRef])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame?.contentWindow || event.source !== frame.contentWindow || !latest.current.enabled) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== DASHBOARD_CONTEXT_MENU_TYPE) return
      const parsed = dashboardContextMenuSchema.safeParse(data)
      if (parsed.success) latest.current.onContextMenu(parsed.data.x, parsed.data.y)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frameRef])

  return { announce }
}
