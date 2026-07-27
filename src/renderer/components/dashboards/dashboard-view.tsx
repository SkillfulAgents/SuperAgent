import { useState, useRef, useCallback, useEffect } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Play, RefreshCw, SquareMousePointer, ExternalLink, Dock, Loader2 } from 'lucide-react'
import { useAgent, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useKeepAlive } from '@renderer/hooks/use-keep-alive'
import { useArtifacts } from '@renderer/hooks/use-artifacts'
import { useUser } from '@renderer/context/user-context'
import { getApiBaseUrl, isElectron, getPlatform, openDashboardExternal } from '@renderer/lib/env'
import { buildDashboardArtifactPath } from '@shared/lib/dashboard-url'
import { AddToDockDialog } from './add-to-dock-dialog'
import { PendingAgentReviews } from './pending-agent-reviews'
import { useRenderTracker } from '@renderer/lib/perf'
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
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [pollFast, setPollFast] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const waitStartedAtRef = useRef<number | null>(null)
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
    || (dashboard?.status === 'running' && !iframeLoaded)
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
    iframeLoaded,
  })

  const nextPollFast = viewState.kind === 'waiting' && viewState.pollFast
  useEffect(() => {
    setPollFast((prev) => (prev === nextPollFast ? prev : nextPollFast))
  }, [nextPollFast])

  const baseUrl = getApiBaseUrl()
  const iframeSrc = `${baseUrl}${buildDashboardArtifactPath(agentSlug, dashboardSlug)}`

  useEffect(() => {
    setIframeLoaded(false)
  }, [iframeSrc])

  const handleRefresh = useCallback(() => {
    setIframeLoaded(false)
    if (iframeRef.current) {
      iframeRef.current.src = iframeSrc
    }
  }, [iframeSrc])

  const handlePopOut = useCallback(() => {
    openDashboardExternal(agentSlug, dashboardSlug, dashboard?.name)
  }, [agentSlug, dashboardSlug, dashboard?.name])

  const handleStartAgent = useCallback(() => {
    startAgent.mutate(agentSlug)
  }, [startAgent, agentSlug])

  const handleRestartAgent = useCallback(async () => {
    setRestarting(true)
    setRestartError(null)
    setIframeLoaded(false)
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

  const autoStartedRef = useRef<string | null>(null)
  useEffect(() => {
    if (autoStartedRef.current === agentSlug) return
    if (!agent || isAgentRunning || isAgentStarting || !canStart) return
    if (startAgent.isError) return
    autoStartedRef.current = agentSlug
    startAgent.mutate(agentSlug)
  }, [agent, agentSlug, isAgentRunning, isAgentStarting, canStart, startAgent])

  const showFrame = isAgentRunning && dashboard?.status === 'running'
  const showOverlay = viewState.kind !== 'ready'
  const actionPending = restarting || stopAgent.isPending || startAgent.isPending

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
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-2 py-2 border-b bg-muted/30">
        <SquareMousePointer className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">{dashboard?.name || dashboardSlug}</span>
        {dashboard?.description && (
          <span className="text-xs text-muted-foreground truncate">
            — {dashboard.description}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {/* TODO: Add Windows support — create .lnk shortcut and pin to taskbar */}
          {isElectron() && getPlatform() === 'darwin' && (
            <Button variant="ghost" size="sm" onClick={() => setDockDialogOpen(true)} title="Add to Dock">
              <Dock className="h-3 w-3" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handlePopOut} title="Open in new window">
            <ExternalLink className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleRefresh} title="Refresh">
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <PendingAgentReviews agentSlug={agentSlug} onReviewResolved={handleRefresh} />
      <AddToDockDialog
        open={dockDialogOpen}
        onOpenChange={setDockDialogOpen}
        agentSlug={agentSlug}
        dashboardSlug={dashboardSlug}
        dashboardName={dashboard?.name || dashboardSlug}
      />
      <div className="flex-1 min-h-0 relative">
        {showOverlay && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background text-muted-foreground p-8">
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
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          className="h-full w-full border-0"
          title={dashboard?.name || dashboardSlug}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          allow="microphone; camera"
          onLoad={() => setIframeLoaded(true)}
        />
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
    (viewState.kind === 'crashed' || (viewState.kind === 'waiting' && viewState.slow))
    && canStart

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-2">
        {showSpinner && <Loader2 className="h-4 w-4 animate-spin" />}
        <p className="text-base">{viewState.message}</p>
      </div>
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
