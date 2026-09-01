import { AgentHome } from '@renderer/components/agents/agent-home/agent-home'
import { TrayManager } from '@renderer/components/tray/tray-manager'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import { WorkflowProvider } from '@renderer/context/workflow-context'
import { useAgent } from '@renderer/hooks/use-agents'
import { agentShareOpenRequested } from '@renderer/router/agent-share-open'
import { isShareSearch } from '@renderer/router/search-schemas'
import { useSearch } from '@tanstack/react-router'
import { useAgentSlug } from './use-agent-slug'

// The agent index owns its agent-scoped dialogs and read-only file-preview tray.
// Keeping this in its own route chunk prevents every sibling agent view from
// joining the common agent navigation path.
export function AgentHomeRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)
  const { onSessionCreated } = usePendingMessages()
  const shareFromUrl = useSearch({ strict: false, select: (s: { share?: unknown }) => isShareSearch(s.share) })
  const openShare = shareFromUrl || agentShareOpenRequested()
  if (!slug || !agent) return null
  const homePreviewId = `agent-home:${agent.slug}`
  return (
    <FilePreviewProvider sessionId={homePreviewId} commentsEnabled={false}>
      <WorkflowProvider sessionId={homePreviewId}>
        <div
          className="file-preview-container relative flex flex-1 min-h-0 min-w-0"
          data-testid="file-preview-container"
        >
          <AgentHome key={agent.slug} agent={agent} onSessionCreated={onSessionCreated} openShare={openShare} />
          <TrayManager
            agentSlug={agent.slug}
            sessionId={homePreviewId}
            browserActive={false}
            filePreviewWideLayout="overlay"
          />
        </div>
      </WorkflowProvider>
    </FilePreviewProvider>
  )
}
