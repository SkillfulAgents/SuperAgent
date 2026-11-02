import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { capturesOwnWindow } from '@renderer/lib/capabilities'
import { uploadFileChunked } from '@renderer/lib/upload'
import type { DashboardSnapshot } from '@shared/lib/dashboard-inspect-schema'
import { buildDashboardCommentMessage, type CommentPin, type ScreenshotGap } from './dashboard-comment-message'
import { inspectDashboard } from './dashboard-frame'
import { captureDashboardFrame, prepareScreenshot } from './dashboard-screenshot'

export type DashboardCommentState =
  | { phase: 'closed' }
  /** Capturing what the person sees before the grid covers it. */
  | { phase: 'opening' }
  | {
      phase: 'open'
      pin: CommentPin | null
      screenshot: Blob | null
      screenshotGap: ScreenshotGap | null
      /** The page as the screenshot caught it. */
      opened: DashboardSnapshot | null
      sending: boolean
      error: string | null
      /** Playing its way out. */
      closing: boolean
    }

/** As long as the overlay's exit animation. */
const CLOSE_MS = 160

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

interface DashboardCommentOptions {
  frameRef: RefObject<HTMLIFrameElement | null>
  /** The agent's canonical slug: where the session runs and the screenshot is stored. */
  agentSlug: string
  /** The slug the app's routes use for the agent, for the "View" link. */
  routeAgentSlug: string
  agentName: string
  dashboard: { name: string; slug: string }
}

/**
 * A comment on a dashboard, from opening comment mode to the session that acts
 * on it. Opening captures the frame first, so the screenshot is what the
 * person saw and not the grid. Sending asks the page what sits under the pin,
 * uploads the screenshot, and starts a session on the dashboard's agent that
 * runs in the background, with a toast that links to it.
 */
export function useDashboardComment({ frameRef, agentSlug, routeAgentSlug, agentName, dashboard }: DashboardCommentOptions) {
  const [state, setState] = useState<DashboardCommentState>({ phase: 'closed' })
  const latest = useRef(state)
  useEffect(() => { latest.current = state })
  // A newer open or close turns a capture still in flight into a no-op.
  const run = useRef(0)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createSession = useCreateSession()
  const navigate = useNavigate()

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  /** Opens comment mode, pinned at `at` (frame CSS pixels) when given. */
  const open = useCallback(async (at?: { x: number; y: number }) => {
    if (latest.current.phase !== 'closed') return
    const mine = ++run.current
    setState({ phase: 'opening' })
    const frame = frameRef.current
    const [screenshot, opened] = await Promise.all([captureDashboardFrame(frame), inspectDashboard(frame)])
    if (mine !== run.current) return
    const rect = frame?.getBoundingClientRect()
    const pin = at && rect && rect.width > 0 && rect.height > 0
      ? { x: clampPercent((at.x / rect.width) * 100), y: clampPercent((at.y / rect.height) * 100) }
      : null
    setState({
      phase: 'open',
      pin,
      screenshot,
      screenshotGap: screenshot ? null : capturesOwnWindow() ? 'failed' : 'unsupported',
      opened,
      sending: false,
      error: null,
      closing: false,
    })
  }, [frameRef])

  const close = useCallback(() => {
    run.current++
    if (latest.current.phase === 'closed') return
    if (latest.current.phase !== 'open') {
      setState({ phase: 'closed' })
      return
    }
    setState({ ...latest.current, closing: true })
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setState((current) => (current.phase === 'open' && current.closing ? { phase: 'closed' } : current))
    }, CLOSE_MS)
  }, [])

  const setPin = useCallback((pin: CommentPin) => {
    setState((current) => (current.phase === 'open' && !current.sending ? { ...current, pin } : current))
  }, [])

  const send = useCallback(async (comment: string, dictated: boolean) => {
    const current = latest.current
    if (current.phase !== 'open' || current.sending || current.closing) return
    const mine = run.current
    setState({ ...current, sending: true, error: null })
    const frame = frameRef.current
    const rect = frame?.getBoundingClientRect()
    const size = { width: rect?.width ?? 0, height: rect?.height ?? 0 }
    const { pin } = current
    const sent = await inspectDashboard(frame, pin ? { x: (pin.x / 100) * size.width, y: (pin.y / 100) * size.height } : undefined)

    let screenshotPath: string | null = null
    let screenshotGap = current.screenshotGap
    if (current.screenshot) {
      try {
        const image = await prepareScreenshot(current.screenshot, pin)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const file = new File([image], `dashboard-comment-${dashboard.slug}-${stamp}.png`, { type: 'image/png' })
        screenshotPath = (await uploadFileChunked<{ path: string }>({ url: `/api/agents/${agentSlug}/upload-file`, file })).path
      } catch (error) {
        console.error('Failed to upload the dashboard comment screenshot:', error)
        screenshotGap = 'failed'
      }
    }

    const message = buildDashboardCommentMessage({
      comment,
      dictated,
      dashboard,
      pin,
      frame: size,
      opened: current.opened,
      sent,
      screenshotPath,
      screenshotGap,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      now: Date.now(),
    })

    try {
      const session = await createSession.mutateAsync({ agentSlug, message })
      toast.success(`Sent to ${agentName}`, {
        description: 'It’s working on your comment in a new session.',
        action: {
          label: 'View',
          onClick: () => void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: routeAgentSlug, sessionId: session.id } }),
        },
      })
      if (mine === run.current) close()
    } catch (error) {
      if (mine !== run.current) return
      setState((now) => (now.phase === 'open'
        ? { ...now, sending: false, error: error instanceof Error ? error.message : 'Failed to send the comment' }
        : now))
    }
  }, [frameRef, agentSlug, routeAgentSlug, agentName, dashboard, createSession, navigate, close])

  return { state, open, close, setPin, send }
}
