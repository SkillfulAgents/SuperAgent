
import { useState, useMemo } from 'react'
import { useAgents } from '@renderer/hooks/use-agents'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useSelection } from '@renderer/context/selection-context'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { CreateAgentDialog } from '@renderer/components/agents/create-agent-dialog'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Download, Loader2, Clock, CalendarClock, LayoutDashboard } from 'lucide-react'
import type { ApiAgent } from '@shared/lib/types/api'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

export function formatRelativeTime(date: Date | string | null | undefined): string | null {
  if (!date) return null
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const absDiff = Math.abs(diffMs)
  const isFuture = diffMs < 0

  if (absDiff < 60_000) return 'just now'
  const mins = Math.floor(absDiff / 60_000)
  if (mins < 60) return isFuture ? `in ${mins}m` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return isFuture ? `in ${hours}h` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return isFuture ? `in ${days}d` : `${days}d ago`
  const months = Math.floor(days / 30)
  return isFuture ? `in ${months}mo` : `${months}mo ago`
}

function AgentCard({ agent }: { agent: ApiAgent }) {
  const { selectAgent } = useSelection()
  const lastWorked = formatRelativeTime(agent.lastActivityAt)
  const nextRun = formatRelativeTime(agent.nextScheduledTaskAt)
  const dashboardCount = agent.dashboardCount ?? 0
  const dashboardNames = agent.dashboardNames ?? []
  const scheduledTaskCount = agent.scheduledTaskCount ?? 0

  return (
    <AgentContextMenu agent={agent}>
      <button
        onClick={() => selectAgent(agent.slug)}
        className="text-left p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors flex flex-col gap-3 overflow-hidden"
      >
        {/* Header: name + status */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="font-medium truncate">{agent.name}</span>
          <AgentStatus
            status={agent.status}
            hasActiveSessions={agent.hasActiveSessions ?? false}
            hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
            className="shrink-0"
          />
        </div>

        {/* Description */}
        {agent.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
        )}

        {/* Details row */}
        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
          {/* Last worked */}
          {lastWorked && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {lastWorked}
            </span>
          )}

          {/* Scheduled tasks */}
          {scheduledTaskCount > 0 && (
            <span className="flex items-center gap-1" title={nextRun ? `Next run: ${nextRun}` : undefined}>
              <CalendarClock className="h-3 w-3" />
              {scheduledTaskCount} task{scheduledTaskCount !== 1 ? 's' : ''}
              {nextRun && <span className="text-muted-foreground/70">&middot; {nextRun}</span>}
            </span>
          )}

          {/* Dashboards */}
          {dashboardCount > 0 && (
            <DashboardChips names={dashboardNames} />
          )}
        </div>
      </button>
    </AgentContextMenu>
  )
}

function DashboardChips({ names }: { names: string[] }) {
  if (names.length <= 2) {
    return (
      <span className="flex items-center gap-1">
        <LayoutDashboard className="h-3 w-3" />
        {names.map((name) => (
          <span key={name} className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
            {name}
          </span>
        ))}
      </span>
    )
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer text-xs text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <LayoutDashboard className="h-3 w-3" />
          {names.length} dashboards
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1">
          {names.map((name) => (
            <span key={name} className="text-xs px-2 py-1 rounded hover:bg-muted">
              {name}
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TemplateCard({ template, onClick }: { template: ApiDiscoverableAgent; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left p-4 rounded-lg border border-dashed bg-card hover:bg-accent/50 transition-colors flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-medium truncate">{template.name}</span>
        <span className="text-xs text-muted-foreground shrink-0">v{template.version}</span>
      </div>
      {template.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{template.description}</p>
      )}
      <p className="text-xs text-muted-foreground/70">{template.skillsetName}</p>
    </button>
  )
}

export function HomePage() {
  const { data: agents, isLoading: agentsLoading } = useAgents()
  const { data: userSettings } = useUserSettings()
  const { data: discoverableAgents } = useDiscoverableAgents()
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], userSettings?.agentOrder),
    [agents, userSettings?.agentOrder]
  )
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<ApiDiscoverableAgent | null>(null)
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()

  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = orderedAgents.length > 0
  const hasTemplates = discoverableAgents && discoverableAgents.length > 0

  return (
    <div className="h-full flex flex-col">
      <header
        className={`shrink-0 flex h-12 items-center gap-2 border-b bg-background px-4 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Agents Section */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Your Agents</h2>
              <Button
                size="sm"
                onClick={() => setCreateAgentOpen(true)}
                className="app-no-drag"
              >
                <Plus className="h-4 w-4 mr-1" />
                New Agent
              </Button>
            </div>

            {agentsLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : hasAgents ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {orderedAgents.map((agent) => (
                  <AgentCard key={agent.slug} agent={agent} />
                ))}
              </div>
            ) : (
              <div className="text-center py-12 border rounded-lg bg-muted/30">
                <Bot className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground mb-4">No agents yet</p>
                <Button onClick={() => setCreateAgentOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Create your first agent
                </Button>
              </div>
            )}
          </section>

          {/* Templates Section */}
          {hasTemplates && (
            <section>
              <h2 className="text-lg font-semibold mb-4">Agent Templates</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {discoverableAgents.map((template) => (
                  <TemplateCard
                    key={`${template.skillsetId}::${template.path}`}
                    template={template}
                    onClick={() => { setSelectedTemplate(template); setCreateAgentOpen(true) }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <CreateAgentDialog
        open={createAgentOpen}
        onOpenChange={(open) => { setCreateAgentOpen(open); if (!open) setSelectedTemplate(null) }}
        initialTemplate={selectedTemplate}
      />
    </div>
  )
}
