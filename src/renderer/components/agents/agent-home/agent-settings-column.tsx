import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { SystemPromptDialog } from '@renderer/components/agents/system-prompt-dialog'
import { DashboardCard } from '@renderer/components/home/dashboard-card'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import type { ApiScheduledTask } from '@shared/lib/types/api'
import { HomeTriggers } from './home-triggers'
import { HomeSkills } from './home-skills'
import { HomeExtras } from './home-extras'
import { HomeConnections } from './home-connections'
import { HomeAgentIntegrations } from './home-agent-integrations'
import { HomeVolumes } from './home-volumes'
import { HomeHooks } from './home-hooks'
import { HomeWidgets } from './home-widgets'
import { HomePanel, useHomeCardLook } from './home-collapsible'

interface AgentSettingsColumnProps {
  agent: ApiAgent
  scheduledTasks: ApiScheduledTask[]
  onRunSkill?: (skillPath: string) => void
  /** Leave out the Connections card, for a page that lists the agent's connections itself. */
  hideConnections?: boolean
  /** A drive the page shows itself, left out of the Drives card. */
  hiddenVolumeId?: string
}

/** An agent's settings, as Agent Home's side column lays them out. */
export function AgentSettingsColumn({ agent, scheduledTasks, onRunSkill, hideConnections, hiddenVolumeId }: AgentSettingsColumnProps) {
  const navigate = useNavigate()
  const { canAdminAgent } = useUser()
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const look = useHomeCardLook()
  const replacedDashboards = useMemo(
    () => new Set((Array.isArray(agent.widgets) ? agent.widgets : []).filter((w) => w.hasDashboard).map((w) => w.slug)),
    [agent.widgets],
  )
  const hooks = <HomeHooks className={look.grouped ? undefined : 'intro-step intro-step-9'} agentSlug={agent.slug} isOwner={canAdminAgent(agent.slug)} />
  const sections = (
    <>
      <HomeTriggers
        className={look.grouped ? undefined : 'intro-step intro-step-4'}
        agentSlug={agent.slug}
        scheduledTasks={scheduledTasks}
        onSelectTask={(taskId: string) => {
          void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agent.slug, taskId } })
        }}
        onSelectWebhook={(webhookId: string) => {
          void navigate({ to: '/agents/$slug/webhooks/$webhookId', params: { slug: agent.slug, webhookId } })
        }}
        onSelectCompletedTasks={() => {
          void navigate({ to: '/agents/$slug/completed-tasks', params: { slug: agent.slug } })
        }}
        onSelectInboundXAgent={() => {
          void navigate({ to: '/agents/$slug/called-from-agents', params: { slug: agent.slug } })
        }}
      />
      {!hideConnections && <HomeConnections className={look.grouped ? undefined : 'intro-step intro-step-5'} agentSlug={agent.slug} />}
      <HomeSkills className={look.grouped ? undefined : 'intro-step intro-step-6'} agentSlug={agent.slug} onRunSkill={onRunSkill} />
      <HomeAgentIntegrations className={look.grouped ? undefined : 'intro-step intro-step-7'} agentSlug={agent.slug} />
      <HomeVolumes className={look.grouped ? undefined : 'intro-step intro-step-8'} agentSlug={agent.slug} hiddenVolumeId={hiddenVolumeId} />
    </>
  )
  return (
    <>
      <HomeWidgets agentSlug={agent.slug} className={look.media} />
      {(Array.isArray(agent.dashboards) ? agent.dashboards : [])
        // An artifact with a widget shows the widget instead of its screenshot.
        .filter((d) => !replacedDashboards.has(d.slug))
        .map((d) => (
          <div key={d.slug} className={look.media}>
            <DashboardCard dashboard={d} agentSlug={agent.slug} />
          </div>
        ))}
      {look.grouped ? <HomePanel>{sections}{hooks}</HomePanel> : sections}
      <HomeExtras className={look.grouped ? undefined : 'intro-step intro-step-9'} agentSlug={agent.slug} onOpenSettings={(tab) => { if (tab === 'system-prompt') setSystemPromptOpen(true) }} />
      {!look.grouped && hooks}
      <SystemPromptDialog
        agent={agent}
        open={systemPromptOpen}
        onOpenChange={setSystemPromptOpen}
      />
    </>
  )
}
