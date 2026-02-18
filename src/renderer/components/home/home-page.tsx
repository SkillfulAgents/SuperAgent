
import { useState } from 'react'
import { useAgents } from '@renderer/hooks/use-agents'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useSessions } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { CreateAgentDialog } from '@renderer/components/agents/create-agent-dialog'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Button } from '@renderer/components/ui/button'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { Plus, Bot, Download, Loader2 } from 'lucide-react'
import type { ApiAgent } from '@shared/lib/types/api'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

function AgentCard({ agent }: { agent: ApiAgent }) {
  const { selectAgent } = useSelection()
  const { data: sessions } = useSessions(agent.slug)
  const hasActiveSessions = sessions?.some((s) => s.isActive) ?? false

  return (
    <button
      onClick={() => selectAgent(agent.slug)}
      className="text-left p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors flex flex-col gap-2 overflow-hidden"
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="font-medium truncate">{agent.name}</span>
        <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} className="shrink-0" />
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
      )}
    </button>
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
  const { data: discoverableAgents } = useDiscoverableAgents()
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<ApiDiscoverableAgent | null>(null)
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()

  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const hasAgents = agents && agents.length > 0
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {agents.map((agent) => (
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
