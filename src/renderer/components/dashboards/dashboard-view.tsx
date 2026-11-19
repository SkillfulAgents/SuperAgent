import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Play, RefreshCw, Loader2 } from 'lucide-react'
import { useAgent, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useKeepAlive } from '@renderer/hooks/use-keep-alive'
import { useArtifacts } from '@renderer/hooks/use-artifacts'
import { useUser } from '@renderer/context/user-context'
import { getApiBaseUrl, openDashboardExternal } from '@renderer/lib/env'
import { addsToDock } from '@renderer/lib/capabilities'
import { apiFetch } from '@renderer/lib/api'
import { getRemoteDeploymentUrl } from '@renderer/lib/api-target'
import { buildDashboardArtifactPath } from '@shared/lib/dashboard-url'
import { AddToDockDialog } from './add-to-dock-dialog'
import { DashboardDispatchDialog } from './dashboard-dispatch-dialog'
import { useDashboardDispatch } from './use-dashboard-dispatch'
import { PendingAgentReviews } from './pending-agent-reviews'
import { DashboardCommentOverlay } from './comments/dashboard-comment-overlay'
import { DashboardFrameMenu } from './comments/dashboard-frame-menu'
import { useDashboardFrameComments } from './comments/dashboard-frame'
import { useDashboardComment } from './comments/use-dashboard-comment'
import { useRenderTracker } from '@renderer/lib/perf'
import { useRegisterDashboardHeader } from '@renderer/context/dashboard-header-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import {
  DASHBOARD_WAIT_BOUND_MS,
  isDashboardUnavailable,
  resolveDashboardViewState,
  type DashboardViewState,
} from './dashboard-view-state'

type OpenOutcome = 'ready' | 'start_failed' | 'not_found' | 'crashed' | 'timeout' | 'load_failed'
/** How a measured attempt began: the open itself, or a person's Retry or Refresh (iOS measures each Reload). A Restart is not measured: it times the agent, not the dashboard. */
type Attempt = 'open' | 'retry' | 'refresh'
/** The view states that end an open as a failure, in the iOS app's `dashboard_failed` terms. */
const OPEN_FAILURES: Partial<Record<DashboardViewState['kind'], OpenOutcome>> = {
  'agent-start-failed': 'start_failed',
  missing: 'not_found',
  crashed: 'crashed',
}

interface DashboardViewProps {
  agentSlug: string
  dashboardSlug: string
}

export function DashboardView({ agentSlug, dashboardSlug }: DashboardViewProps) {
  useRenderTracker('DashboardView')
  const [dockDialogOpen, setDockDialogOpen] = useState(false)
  const [pollFast, setPollFast] = useState(false)
  const [pollWatching, setPollWatching] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [restarting, setRestarting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [frameLoading, setFrameLoading] = useState(true)
  // Bumped to remount the iframe (a fresh document fetch); onError retries and
  // the loaded-too-early reload below both go through it.
  const [frameAttempt, setFrameAttempt] = useState(0)
  // The frame finished loading while the dashboard was still 'starting' — the
  // document may be a held request that timed out into an error body, so it
  // must be refetched once the dashboard actually reports running.
  const [frameLoadedEarly, setFrameLoadedEarly] = useState(false)
  // The last check of the loaded page found the dashboard not being served.
  const [frameUnavailable, setFrameUnavailable] = useState(false)
  const frameErrorRetriesRef = useRef(0)
  const frameRetryTimerRef = useRef<number | null>(null)
  // Monotonic token so a probe finishing after a navigation/remount is ignored.
  const frameProbeSeqRef = useRef(0)
  const [restartError, setRestartError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const waitStartedAtRef = useRef<number | null>(null)
  const autoStartedRef = useRef<string | null>(null)
  // One open and its attempts, reported as the iOS app reports them. Only time on screen is measured:
  // leaving the screen ends an attempt with no outcome, and one begun off screen is not timed.
  const openRef = useRef<{ at: number; opened: boolean; settled: boolean; wakeAttempted: boolean | null; attempt: Attempt }>({
    at: Date.now(), opened: false, settled: document.visibilityState === 'hidden', wakeAttempted: null, attempt: 'open',
  })
  const [attemptCount, setAttemptCount] = useState(0)
  const wasDocumentHiddenRef = useRef(document.visibilityState === 'hidden')
  const { data: agent, refetch: refetchAgent } = useAgent(agentSlug)
  const { data: artifacts } = useArtifacts(agentSlug, { pollFast, watching: pollWatching })
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const { canUseAgent } = useUser()
  const canStart = canUseAgent(agentSlug)
  useKeepAlive(agentSlug)

  const dashboard = artifacts?.find((a) => a.slug === dashboardSlug)
  const artifactsLoaded = artifacts !== undefined
  const isAgentRunning = agent?.status === 'running'
  const isAgentStarting = startAgent.isPending

  const trackingWait = isAgentRunning && (
    !artifactsLoaded
    || (dashboard != null && (dashboard.status === 'starting' || dashboard.status === 'stopped'))
  )

  const waitElapsedMs = waitStartedAtRef.current === null
    ? 0
    : now - waitStartedAtRef.current
  const waitIsSlow = trackingWait && waitElapsedMs >= DASHBOARD_WAIT_BOUND_MS

  useEffect(() => {
    if (!trackingWait) {
      waitStartedAtRef.current = null
      return
    }
    if (waitStartedAtRef.current === null) {
      waitStartedAtRef.current = Date.now()
    }
    if (waitIsSlow) return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [trackingWait, waitIsSlow])

  const viewState = resolveDashboardViewState({
    agentRunning: isAgentRunning,
    artifactsLoaded,
    dashboard,
    canStart,
    startFailed: startAgent.isError,
    waitElapsedMs,
    frameLoad: !frameUnavailable ? 'ok' : frameLoading ? 'retrying' : 'failed',
  })

  const nextPollFast = 'pollFast' in viewState && viewState.pollFast
  // Any state carrying pollFast is a mounted-and-unresolved view; it keeps a
  // 1s polling floor even after pollFast turns off at the slow bound.
  const nextPollWatching = 'pollFast' in viewState
  useEffect(() => {
    setPollFast((prev) => (prev === nextPollFast ? prev : nextPollFast))
    setPollWatching((prev) => (prev === nextPollWatching ? prev : nextPollWatching))
  }, [nextPollFast, nextPollWatching])

  const baseUrl = getApiBaseUrl()
  // Dashboard processes receive the canonical agent id in
  // DASHBOARD_BASE_PATH. Keep their browser-visible URL on that same stable
  // id even when the surrounding app route uses a decorative display slug.
  const dashboardAgentSlug = agent?.slug ?? agentSlug
  const dashboardPath = buildDashboardArtifactPath(dashboardAgentSlug, dashboardSlug)
  const iframeSrc = `${getRemoteDeploymentUrl() ?? baseUrl}${dashboardPath}`
  const dashboardDispatch = useDashboardDispatch(iframeRef)

  const { track } = useAnalyticsTracking()
  const agentLoaded = agent !== undefined
  const dashboardStatus = dashboard?.status
  useEffect(() => {
    const open = openRef.current
    if (open.opened || !agentLoaded) return
    open.opened = true
    track('dashboard_opened', { agent_key: dashboardAgentSlug })
  }, [agentLoaded, track, dashboardAgentSlug])
  useEffect(() => {
    const open = openRef.current
    if (open.wakeAttempted !== null || !agentLoaded || (isAgentRunning && !artifactsLoaded)) return
    // As on iOS, an open that first finds the agent asleep or its dashboard not yet serving had to wake it.
    open.wakeAttempted = !isAgentRunning || (dashboardStatus !== undefined && dashboardStatus !== 'running')
  }, [agentLoaded, isAgentRunning, artifactsLoaded, dashboardStatus])
  const settleOpen = useCallback((outcome: OpenOutcome) => {
    const open = openRef.current
    if (open.settled || !open.opened) return
    open.settled = true
    const elapsedMs = Date.now() - open.at
    const wakeAttempted = open.wakeAttempted ?? true
    if (outcome === 'ready') {
      track('dashboard_ready', { agent_key: dashboardAgentSlug, time_to_ready_ms: elapsedMs, wake_attempted: wakeAttempted, attempt: open.attempt })
    } else {
      track('dashboard_failed', { agent_key: dashboardAgentSlug, reason_code: outcome, duration_ms: elapsedMs, wake_attempted: wakeAttempted, attempt: open.attempt })
    }
  }, [track, dashboardAgentSlug])
  /** A person's Retry or Refresh: a new measured attempt of the same open. */
  const beginAttempt = useCallback((attempt: Exclude<Attempt, 'open'>, wakeAttempted: boolean) => {
    openRef.current = { ...openRef.current, at: Date.now(), settled: document.visibilityState === 'hidden', wakeAttempted, attempt }
    // A check of the page from before this attempt must not settle it.
    frameProbeSeqRef.current++
    setAttemptCount((count) => count + 1)
  }, [])
  const openFailure = OPEN_FAILURES[viewState.kind]
  useEffect(() => {
    if (!openFailure) return
    // Crashed and missing are the open's outcomes. A Retry or Refresh ends in ready, a failed start or
    // load, or timeout: the dashboard list cached before it can still say crashed meanwhile.
    if (openFailure !== 'start_failed' && openRef.current.attempt !== 'open') return
    settleOpen(openFailure)
  }, [openFailure, settleOpen])
  useEffect(() => {
    const id = window.setTimeout(() => settleOpen('timeout'), openRef.current.at + DASHBOARD_WAIT_BOUND_MS - Date.now())
    return () => window.clearTimeout(id)
  }, [settleOpen, attemptCount])

  const dashboardName = dashboard?.name || dashboardSlug
  const commentTarget = useMemo(() => ({ name: dashboardName, slug: dashboardSlug }), [dashboardName, dashboardSlug])
  const comment = useDashboardComment({
    frameRef: iframeRef,
    agentSlug: dashboardAgentSlug,
    routeAgentSlug: agentSlug,
    agentName: agent?.name ?? dashboardAgentSlug,
    dashboard: commentTarget,
  })
  const [frameMenuAt, setFrameMenuAt] = useState<{ x: number; y: number } | null>(null)
  const frameComments = useDashboardFrameComments(iframeRef, canStart, (x, y) => setFrameMenuAt({ x, y }))
  const commentState = comment.state
  const { open: openComment, close: closeComment } = comment
  const handleToggleComment = useCallback(() => {
    if (commentState.phase === 'closed') void openComment()
    else if (commentState.phase === 'open' && !commentState.sending) closeComment()
  }, [commentState, openComment, closeComment])
  const handleCommentHere = useCallback((at: { x: number; y: number }) => {
    // The capture hides the menu if it is still on screen.
    setFrameMenuAt(null)
    void openComment(at)
  }, [openComment])

  const handleRefresh = useCallback(() => {
    if (iframeRef.current) {
      setRefreshing(true)
      setFrameLoading(true)
      // A fresh frame, not a new src: a frame that wandered off the workspace
      // would otherwise reload as that other site's navigation, unsigned.
      setFrameAttempt((attempt) => attempt + 1)
    }
  }, [])

  const handlePopOut = useCallback(() => {
    openDashboardExternal(dashboardAgentSlug, dashboardSlug, dashboard?.name)
  }, [dashboardAgentSlug, dashboardSlug, dashboard?.name])

  const handleAddToDock = useCallback(() => {
    setDockDialogOpen(true)
  }, [])

  const handleStartAgent = useCallback(() => {
    beginAttempt('retry', true)
    startAgent.mutate(agentSlug)
  }, [beginAttempt, startAgent, agentSlug])

  const handleRefreshClick = useCallback(() => {
    beginAttempt('refresh', !(isAgentRunning && dashboard?.status === 'running'))
    handleRefresh()
  }, [beginAttempt, handleRefresh, isAgentRunning, dashboard?.status])

  const handleRestartAgent = useCallback(async () => {
    // The deliberate stop must not re-trigger this view's auto-start effect.
    autoStartedRef.current = agentSlug
    setRestarting(true)
    setRestartError(null)
    waitStartedAtRef.current = Date.now()
    try {
      if (isAgentRunning) {
        await stopAgent.mutateAsync(agentSlug)
      }
      await startAgent.mutateAsync(agentSlug)
    } catch (error) {
      console.error('Failed to restart agent:', error)
      setRestartError(error instanceof Error ? error.message : 'Failed to restart agent')
    } finally {
      setRestarting(false)
    }
  }, [isAgentRunning, stopAgent, startAgent, agentSlug])

  const autoStartAgent = useCallback((currentAgent = agent, force = false) => {
    // A hidden dashboard must be allowed to auto-sleep. It is explicitly
    // re-armed by the visibility listener below when the user returns.
    if (document.visibilityState === 'hidden') return

    // Treat the current foreground visit as handled while the agent is
    // running. This keeps a deliberate stop from being immediately undone.
    if (currentAgent?.status === 'running') {
      autoStartedRef.current = agentSlug
      return
    }

    if (!force && autoStartedRef.current === agentSlug) return
    if (!currentAgent || isAgentStarting || restarting || !canStart) return
    if (startAgent.isError) return
    autoStartedRef.current = agentSlug
    startAgent.mutate(agentSlug)
  }, [
    agent,
    agentSlug,
    isAgentStarting,
    restarting,
    canStart,
    startAgent,
  ])
  const autoStartAgentRef = useRef(autoStartAgent)
  const refetchAgentRef = useRef(refetchAgent)
  autoStartAgentRef.current = autoStartAgent
  refetchAgentRef.current = refetchAgent

  useEffect(() => {
    autoStartAgent()
  }, [autoStartAgent])

  useEffect(() => {
    let visibilityCheck = 0

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasDocumentHiddenRef.current = true
        openRef.current.settled = true
        visibilityCheck += 1
        return
      }
      if (!wasDocumentHiddenRef.current) return
      wasDocumentHiddenRef.current = false
      const currentCheck = ++visibilityCheck

      // Reconcile first: the browser may deliver the stopped status only after
      // visibilitychange, so the cached agent can still say "running" here.
      // The old one-shot latch otherwise survives for the component's entire
      // mounted life, which is why navigation used to be the only recovery.
      void refetchAgentRef.current()
        .then(({ data: currentAgent }) => {
          if (
            currentCheck !== visibilityCheck
            || document.visibilityState === 'hidden'
          ) return
          autoStartAgentRef.current(currentAgent, true)
        })
        .catch(() => {})
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      visibilityCheck += 1
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [agentSlug])

  const dashboardRunning = isAgentRunning && dashboard?.status === 'running'
  // Mount the iframe while the dashboard server is still starting: the
  // container proxy holds the document request until the server binds, so the
  // fetch overlaps startup instead of following it. The install phase is
  // excluded — it can outlast the proxy's hold.
  const optimisticStart = isAgentRunning
    && dashboard?.status === 'starting'
    && dashboard.startupPhase !== 'installing-dependencies'
  const showFrame = dashboardRunning || optimisticStart
  const actionPending = restarting || stopAgent.isPending || startAgent.isPending

  const dashboardHeader = useMemo(() => ({
    agentSlug,
    dashboardSlug,
    dashboardName: dashboard?.name || dashboardSlug,
    isAgentStarting,
    actions: showFrame
      ? {
          onOpenExternal: handlePopOut,
          onRefresh: handleRefreshClick,
          ...(addsToDock() ? { onAddToDock: handleAddToDock } : {}),
          refreshState: refreshing ? 'refreshing' as const : frameLoading ? 'loading' as const : 'idle' as const,
          ...(canStart
            ? {
                comment: {
                  onToggle: handleToggleComment,
                  state: commentState.phase === 'open'
                    ? (commentState.sending ? 'sending' as const : 'open' as const)
                    : commentState.phase === 'opening' ? 'opening' as const : 'idle' as const,
                  disabled: !dashboardRunning,
                },
              }
            : {}),
        }
      : null,
  }), [
    agentSlug,
    dashboardSlug,
    dashboard?.name,
    isAgentStarting,
    showFrame,
    handlePopOut,
    handleRefreshClick,
    handleAddToDock,
    refreshing,
    frameLoading,
    canStart,
    handleToggleComment,
    commentState,
    dashboardRunning,
  ])

  // A different dashboard is not the one the comment is on. A reload of this one
  // (a resolved review, a retry) keeps the comment and its typed text; only an
  // open right-click menu, placed on the old document, goes.
  useEffect(() => {
    closeComment()
  }, [iframeSrc, closeComment])
  useEffect(() => {
    setFrameMenuAt(null)
  }, [iframeSrc, frameAttempt])
  useRegisterDashboardHeader(dashboardHeader)

  useEffect(() => {
    if (showFrame) setFrameLoading(true)
  }, [iframeSrc, showFrame])

  // Navigating to a different dashboard resets the retry machinery.
  useEffect(() => {
    frameErrorRetriesRef.current = 0
    frameProbeSeqRef.current++
    setFrameLoadedEarly(false)
    setFrameUnavailable(false)
    setFrameAttempt(0)
  }, [iframeSrc])

  // Refetch a document that finished loading before the dashboard reported
  // running (it may be the proxy's timeout error body rather than the app).
  useEffect(() => {
    if (dashboardRunning && frameLoadedEarly) {
      setFrameLoadedEarly(false)
      setFrameLoading(true)
      setFrameAttempt((attempt) => attempt + 1)
    }
  }, [dashboardRunning, frameLoadedEarly])

  useEffect(() => () => {
    if (frameRetryTimerRef.current !== null) window.clearTimeout(frameRetryTimerRef.current)
    // A probe still out when the view goes must not report on an open nobody waits for.
    frameProbeSeqRef.current++
  }, [])

  const scheduleFrameRetry = useCallback(() => {
    // Failed document load. Bounded backoff — a frame left in this state was
    // previously blank forever with no recovery.
    if (frameErrorRetriesRef.current >= 3) {
      setFrameLoading(false)
      settleOpen('load_failed')
      return
    }
    const delay = 1_000 * 2 ** frameErrorRetriesRef.current
    frameErrorRetriesRef.current += 1
    setFrameLoading(true)
    frameRetryTimerRef.current = window.setTimeout(() => {
      setFrameAttempt((attempt) => attempt + 1)
    }, delay)
  }, [settleOpen])

  // Browsers fire 'load' even for a failed iframe navigation (they render an
  // error document), and iframes get no 'error' event for it — the load event
  // alone cannot confirm the dashboard actually answered. Probe the same URL
  // right after each load while the dashboard reports running: an answer of
  // the dashboard's own means the loaded document was real; none schedules a
  // retry, and the view covers the document until a check passes.
  const verifyFrameDocument = useCallback(async () => {
    const seq = ++frameProbeSeqRef.current
    let ok = false
    try {
      const res = await apiFetch(dashboardPath, { method: 'HEAD', cache: 'no-store' })
      ok = !isDashboardUnavailable(res.status)
    } catch {
      ok = false
    }
    if (seq !== frameProbeSeqRef.current) return
    setFrameUnavailable(!ok)
    if (ok) {
      setFrameLoading(false)
      frameErrorRetriesRef.current = 0
      settleOpen('ready')
    } else {
      scheduleFrameRetry()
    }
  }, [dashboardPath, scheduleFrameRetry, settleOpen])

  if (!showFrame) {
    return (
      <div className="flex-1 overflow-y-auto flex flex-col items-center text-muted-foreground p-8">
        <div className="m-auto flex flex-col items-center gap-4 w-full max-w-2xl">
          <DashboardStatusBody
            viewState={viewState}
            startErrorMessage={startAgent.error?.message}
            restartErrorMessage={restartError ?? undefined}
            onRetry={handleStartAgent}
            onRestart={handleRestartAgent}
            onRefresh={handleRefreshClick}
            retryPending={startAgent.isPending}
            restartPending={actionPending}
            canStart={canStart}
          />
          <div className="w-full">
            <PendingAgentReviews agentSlug={agentSlug} readOnly={!canStart} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PendingAgentReviews agentSlug={agentSlug} readOnly={!canStart} onReviewResolved={handleRefresh} />
      <AddToDockDialog
        open={dockDialogOpen}
        onOpenChange={setDockDialogOpen}
        agentSlug={dashboardAgentSlug}
        dashboardSlug={dashboardSlug}
        dashboardName={dashboard?.name || dashboardSlug}
      />
      <DashboardDispatchDialog
        request={dashboardDispatch.pending}
        dashboardAgentSlug={dashboardAgentSlug}
        dashboardAgentName={agent?.name}
        dashboardSlug={dashboardSlug}
        onResolve={dashboardDispatch.resolvePending}
      />
      <div className="flex-1 min-h-0 relative">
        <iframe
          key={frameAttempt}
          ref={iframeRef}
          src={iframeSrc}
          className="h-full w-full border-0"
          title={dashboard?.name || dashboardSlug}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          allow="microphone; camera"
          onLoad={() => {
            setRefreshing(false)
            frameComments.announce()
            if (!dashboardRunning) {
              setFrameLoading(false)
              setFrameLoadedEarly(true)
              return
            }
            void verifyFrameDocument()
          }}
        />
        {canStart && dashboardRunning && (
          <DashboardFrameMenu
            at={frameMenuAt}
            onComment={handleCommentHere}
            onRefresh={handleRefreshClick}
            onClose={() => setFrameMenuAt(null)}
          />
        )}
        {commentState.phase === 'open' && (
          <DashboardCommentOverlay
            pin={commentState.pin}
            onPin={comment.setPin}
            onSend={(text, dictated) => void comment.send(text, dictated)}
            onClose={closeComment}
            sending={commentState.sending}
            error={commentState.error}
            closing={commentState.closing}
          />
        )}
        {viewState.kind !== 'ready' && (
          <div className="absolute inset-0 z-10 bg-background flex flex-col items-center justify-center p-8 text-muted-foreground">
            <DashboardStatusBody
              viewState={viewState}
              startErrorMessage={startAgent.error?.message}
              restartErrorMessage={restartError ?? undefined}
              onRetry={handleStartAgent}
              onRestart={handleRestartAgent}
              onRefresh={handleRefreshClick}
              retryPending={startAgent.isPending}
              restartPending={actionPending}
              canStart={canStart}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function DashboardStatusBody({
  viewState,
  startErrorMessage,
  restartErrorMessage,
  onRetry,
  onRestart,
  onRefresh,
  retryPending,
  restartPending,
  canStart,
}: {
  viewState: DashboardViewState
  startErrorMessage?: string
  restartErrorMessage?: string
  onRetry: () => void
  onRestart: () => void
  onRefresh: () => void
  retryPending: boolean
  restartPending: boolean
  canStart: boolean
}) {
  if (viewState.kind === 'ready') return null

  const showSpinner = 'showSpinner' in viewState && viewState.showSpinner
  const showRetry = viewState.kind === 'agent-start-failed' && canStart
  const showRestart =
    (viewState.kind === 'crashed' || ('slow' in viewState && viewState.slow))
    && canStart

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-2">
        {showSpinner && <Loader2 className="h-4 w-4 animate-spin" />}
        <p className="text-base">{viewState.message}</p>
      </div>
      {'detail' in viewState && viewState.detail && (
        <p className="text-sm text-muted-foreground">{viewState.detail}</p>
      )}
      {showRetry && (
        <Button onClick={onRetry} disabled={retryPending}>
          <Play className="mr-2 h-4 w-4" />
          Retry
        </Button>
      )}
      {viewState.kind === 'load-failed' && (
        <Button onClick={onRefresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      )}
      {showRestart && (
        <Button onClick={onRestart} disabled={restartPending}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Restart agent
        </Button>
      )}
      {viewState.kind === 'agent-start-failed' && startErrorMessage && (
        <p className="text-sm text-destructive">{startErrorMessage}</p>
      )}
      {showRestart && restartErrorMessage && (
        <p className="text-sm text-destructive">{restartErrorMessage}</p>
      )}
    </div>
  )
}
