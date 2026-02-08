import { useRef, useCallback } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Play, RefreshCw, LayoutDashboard } from 'lucide-react'
import { useAgent, useStartAgent } from '@renderer/hooks/use-agents'
import { useArtifacts } from '@renderer/hooks/use-artifacts'
import { getApiBaseUrl } from '@renderer/lib/env'

interface DashboardViewProps {
  agentSlug: string
  dashboardSlug: string
}

export function DashboardView({ agentSlug, dashboardSlug }: DashboardViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { data: agent } = useAgent(agentSlug)
  const { data: artifacts } = useArtifacts(agentSlug)
  const startAgent = useStartAgent()

  const dashboard = artifacts?.find((a) => a.slug === dashboardSlug)
  const isAgentRunning = agent?.status === 'running'
  const isDashboardRunning = dashboard?.status === 'running'

  const baseUrl = getApiBaseUrl()
  const iframeSrc = `${baseUrl}/api/agents/${agentSlug}/artifacts/${dashboardSlug}/`

  const handleRefresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeSrc
    }
  }, [iframeSrc])

  const handleStartAgent = useCallback(() => {
    startAgent.mutate(agentSlug)
  }, [startAgent, agentSlug])

  if (!isAgentRunning || !isDashboardRunning) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground p-8">
        <LayoutDashboard className="h-12 w-12 opacity-50" />
        <div className="text-center">
          <p className="text-lg font-medium mb-1">
            {dashboard?.name || dashboardSlug}
          </p>
          <p>
            {!isAgentRunning
              ? 'Agent is not running. Start the agent to view this dashboard.'
              : 'Dashboard is not running. It will start automatically when the agent starts.'}
          </p>
        </div>
        {!isAgentRunning && (
          <Button
            onClick={handleStartAgent}
            disabled={startAgent.isPending}
          >
            <Play className="mr-2 h-4 w-4" />
            Start Agent
          </Button>
        )}
        {startAgent.isError && (
          <p className="text-sm text-destructive">{startAgent.error.message}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{dashboard?.name || dashboardSlug}</span>
        {dashboard?.description && (
          <span className="text-xs text-muted-foreground truncate">
            — {dashboard.description}
          </span>
        )}
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className="flex-1 w-full border-0"
        title={dashboard?.name || dashboardSlug}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  )
}
