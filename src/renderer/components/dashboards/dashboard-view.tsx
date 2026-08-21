import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Play, RefreshCw, Loader2 } from 'lucide-react'
import { useAgent, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useKeepAlive } from '@renderer/hooks/use-keep-alive'
import { useArtifacts } from '@renderer/hooks/use-artifacts'
import { useUser } from '@renderer/context/user-context'
import { targetIsRemote } from '@renderer/lib/api-target'
import { getApiBaseUrl, isElectron, getPlatform, openDashboardExternal } from '@renderer/lib/env'
import { buildDashboardArtifactPath } from '@shared/lib/dashboard-url'
import { z } from 'zod'

const CloudDashboardSessionSchema = z.object({
  useCloudOrigin: z.boolean(),
  origin: z.string().nullable(),
})
import { AddToDockDialog } from './add-to-dock-dialog'
import { PendingAgentReviews } from './pending-agent-reviews'
import { useRenderTracker } from '@renderer/lib/perf'
import { useRegisterDashboardHeader } from '@renderer/context/dashboard-header-context'
import {
  DASHBOARD_WAIT_BOUND_MS,
  resolveDashboardViewState,
  type DashboardViewState,
} from './dashboard-view-state'

interface DashboardViewProps {
  agentSlug: string
  dashboardSlug: string
}

export function DashboardView({ agentSlug, dashboardSlug }: DashboardViewProps) {
  useRenderTracker('DashboardView')
  const [dockDialogOpen, setDockDialogOpen] = useState(false)
  const [pollFast, setPollFast] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [restarting, setRestarting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [frameLoading, setFrameLoading] = useState(true)
  const [restartError, setRestartError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const waitStartedAtRef = useRef<number | null>(null)
  const autoStartedRef = useRef<string | null>(null)
  const { data: agent } = useAgent(agentSlug)
  const { data: artifacts } = useArtifacts(agentSlug, { pollFast })
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
  })

  const nextPollFast = 'pollFast' in viewState && viewState.pollFast
  useEffect(() => {
    setPollFast((prev) => (prev === nextPollFast ? prev : nextPollFast))
  }, [nextPollFast])

  const baseUrl = getApiBaseUrl()
  // Dashboard processes receive the canonical agent id in
  // DASHBOARD_BASE_PATH. Keep their browser-visible URL on that same stable
  // id even when the surrounding app route uses a decorative display slug.
  const dashboardAgentSlug = agent?.slug ?? agentSlug
  const doorSrc = `${baseUrl}${buildDashboardArtifactPath(dashboardAgentSlug, dashboardSlug)}`
  // Electron cloud windows wait until ensure settles so the first document is
  // the cloud origin, not the door (which would then navigate and go blank).
  // Local and web mount the door immediately.
  const waitForCloudOrigin = isElectron()
    && Boolean(window.electronAPI?.ensureCloudDashboardSession)
    && targetIsRemote()
  const [iframeSrc, setIframeSrc] = useState<string | null>(waitForCloudOrigin ? null : doorSrc)

  useEffect(() => {
    const ensure = window.electronAPI?.ensureCloudDashboardSession
    if (!waitForCloudOrigin || !ensure) {
      setIframeSrc(doorSrc)
      return
    }
    setIframeSrc(null)
    let cancelled = false
    void ensure().then((raw) => {
      if (cancelled) return
      const session = CloudDashboardSessionSchema.parse(raw)
      const origin = session.useCloudOrigin && session.origin
        ? session.origin.replace(/\/+$/, '')
        : getApiBaseUrl()
      setIframeSrc(`${origin}${buildDashboardArtifactPath(dashboardAgentSlug, dashboardSlug)}`)
    }).catch(() => {
      if (!cancelled) setIframeSrc(doorSrc)
    })
    return () => {
      cancelled = true
    }
  }, [doorSrc, dashboardAgentSlug, dashboardSlug, waitForCloudOrigin])

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && iframeSrc) {
      setRefreshing(true)
      setFrameLoading(true)
      iframeRef.current.src = iframeSrc
    }
  }, [iframeSrc])

  const handlePopOut = useCallback(() => {
    openDashboardExternal(dashboardAgentSlug, dashboardSlug, dashboard?.name)
  }, [dashboardAgentSlug, dashboardSlug, dashboard?.name])

  const handleAddToDock = useCallback(() => {
    setDockDialogOpen(true)
  }, [])

  const handleStartAgent = useCallback(() => {
    startAgent.mutate(agentSlug)
  }, [startAgent, agentSlug])

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

  useEffect(() => {
    if (autoStartedRef.current === agentSlug) return
    if (!agent || isAgentRunning || isAgentStarting || !canStart) return
    if (startAgent.isError) return
    autoStartedRef.current = agentSlug
    startAgent.mutate(agentSlug)
  }, [agent, agentSlug, isAgentRunning, isAgentStarting, canStart, startAgent])

  const showFrame = isAgentRunning && dashboard?.status === 'running'
  const actionPending = restarting || stopAgent.isPending || startAgent.isPending

  const dashboardHeader = useMemo(() => ({
    agentSlug,
    dashboardSlug,
    dashboardName: dashboard?.name || dashboardSlug,
    actions: showFrame
      ? {
          onOpenExternal: handlePopOut,
          onRefresh: handleRefresh,
          ...(isElectron() && getPlatform() === 'darwin' ? { onAddToDock: handleAddToDock } : {}),
          refreshState: refreshing ? 'refreshing' as const : frameLoading ? 'loading' as const : 'idle' as const,
        }
      : null,
  }), [
    agentSlug,
    dashboardSlug,
    dashboard?.name,
    showFrame,
    handlePopOut,
    handleRefresh,
    handleAddToDock,
    refreshing,
    frameLoading,
  ])
  useRegisterDashboardHeader(dashboardHeader)

  useEffect(() => {
    if (showFrame) setFrameLoading(true)
  }, [iframeSrc, showFrame])

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
            retryPending={startAgent.isPending}
            restartPending={actionPending}
            canStart={canStart}
          />
          <div className="w-full">
            <PendingAgentReviews agentSlug={agentSlug} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PendingAgentReviews agentSlug={agentSlug} onReviewResolved={handleRefresh} />
      <AddToDockDialog
        open={dockDialogOpen}
        onOpenChange={setDockDialogOpen}
        agentSlug={dashboardAgentSlug}
        dashboardSlug={dashboardSlug}
        dashboardName={dashboard?.name || dashboardSlug}
      />
      <div className="flex-1 min-h-0 relative">
        {iframeSrc ? (
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            className="h-full w-full border-0"
            title={dashboard?.name || dashboardSlug}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            allow="microphone; camera"
            onLoad={() => {
              setFrameLoading(false)
              setRefreshing(false)
            }}
          />
        ) : null}
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
  retryPending,
  restartPending,
  canStart,
}: {
  viewState: DashboardViewState
  startErrorMessage?: string
  restartErrorMessage?: string
  onRetry: () => void
  onRestart: () => void
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
