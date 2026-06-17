
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { SystemPromptDialog } from '@renderer/components/agents/system-prompt-dialog'
import { AgentHome } from '@renderer/components/agents/agent-home/agent-home'
import { useState } from 'react'
import { useAgent } from '@renderer/hooks/use-agents'
import { useParams } from '@tanstack/react-router'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import { useRenderTracker } from '@renderer/lib/perf'

/**
 * The agent index leaf (agentHomeRoute, `/agents/$slug`). Every agent sub-view
 * is now its own route under AgentShell (api-logs/connections/task/webhook/
 * dashboard/chat/session, R5–R9), so the bare agent index unambiguously means
 * "home" — this renders AgentHome plus the agent-scoped dialogs it opens, and
 * never has to switch on the Selection sub-view.
 *
 * The shared header chrome + agent-level banners live in the AgentShell layout
 * (migration plan §8.1), so this renders only the body that fills AgentShell's
 * `<Outlet/>`.
 */
export function AgentBody() {
  useRenderTracker('AgentBody')
  // Agent slug comes from the URL (authoritative).
  const agentSlug = (useParams({ strict: false }) as { slug?: string }).slug ?? null
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const { data: agent } = useAgent(agentSlug)
  const { onSessionCreated } = usePendingMessages()

  // Defensive: AgentBody only renders under the agent route, so the slug is set
  // (the bridge mirrors it from the URL). Bail rather than render a broken shell.
  if (!agentSlug) return null

  return (
    <>
      {agent && (
        <AgentHome
          key={agent.slug}
          agent={agent}
          onSessionCreated={onSessionCreated}
          onOpenSettings={(tab?: string) => {
            if (tab === 'system-prompt') {
              setSystemPromptOpen(true)
              return
            }
            setSettingsTab(tab)
            setSettingsOpen(true)
          }}
        />
      )}

      {agent && (
        <>
          <AgentSettingsDialog
            agent={agent}
            open={settingsOpen}
            onOpenChange={(open) => { setSettingsOpen(open); if (!open) setSettingsTab(undefined) }}
            initialTab={settingsTab}
          />
          <SystemPromptDialog
            agent={agent}
            open={systemPromptOpen}
            onOpenChange={setSystemPromptOpen}
          />
        </>
      )}
    </>
  )
}

if (__RENDER_TRACKING__) {
  (AgentBody as any).whyDidYouRender = true
}
