import { useEffect, useId, useState, type ReactNode } from 'react'
import { Brain, Mail, NotebookPen, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@renderer/components/ui/switch'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { ProvisionedAppCard } from '@renderer/components/agent-integrations/provisioned-app-card'
import { SlackConnectionSettings } from '@renderer/components/agent-integrations/slack-setup'
import { publicSlackDelivery } from '@shared/lib/chat-integrations/public'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useAgents } from '@renderer/hooks/use-agents'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useAgentSkills, useDiscoverableSkills, useDeleteSkill, useInstallSkill } from '@renderer/hooks/use-agent-skills'
import { useAgentIntegrations, useAvailableAgentIntegrationProviders } from '@renderer/hooks/use-agent-integrations'
import { useTeamBrainAccess } from '@renderer/hooks/use-team-brain-access'
import { AgentIntegrationSetupDialog } from '@renderer/components/agent-integrations/agent-integration-setup-dialog'
import { integrationSetupProviders } from '@renderer/components/agent-integrations/setup-providers'
import type { IntegrationSetupProvider } from '@renderer/components/agent-integrations/setup-types'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import { DREAM_SKILL_PATH, isPublicDreamSkill } from '@shared/lib/skillset-provider/dream-skill'

function needsSlackSetup(integration: PublicAgentIntegration) {
  if (integration.provider !== 'slack') return false
  if (integration.provisionedApp) return !integration.provisionedApp.installed
  const slack = publicSlackDelivery(integration)
  return !!slack?.webhook && !slack.botTokenSaved
}

export function AgentAddonsStep({ header, agentSlug, onBusyChange }: {
  header: ReactNode
  agentSlug: string
  onBusyChange: (busy: boolean) => void
}) {
  const skills = useAgentSkills(agentSlug)
  const discoverable = useDiscoverableSkills(agentSlug)
  const install = useInstallSkill()
  const remove = useDeleteSkill()
  const preferences = useAgentPreferences(agentSlug)
  const updatePreferences = useUpdateAgentPreferences(agentSlug)
  const { data: agents } = useAgents()
  const brain = agents?.find(agent => agent.teamBrain)
  const access = useTeamBrainAccess(brain?.slug ?? '', brain?.teamBrain?.volumeId)
  const { data: providers } = useAvailableAgentIntegrationProviders()
  const { data: integrations } = useAgentIntegrations(agentSlug)
  const [setup, setSetup] = useState<IntegrationSetupProvider | null>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const resume = integrations?.find(row => row.id === resumeId && needsSlackSetup(row))
  const [changingSkill, setChangingSkill] = useState(false)

  const dream = discoverable.data?.find(s => s.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && s.path === DREAM_SKILL_PATH)
  const installed = skills.data?.find(isPublicDreamSkill)
  const busy = changingSkill || updatePreferences.isPending || access.isChanging(agentSlug)
  useEffect(() => {
    onBusyChange(busy)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])

  async function toggleDream(on: boolean) {
    setChangingSkill(true)
    try {
      if (on && dream) {
        await install.mutateAsync({ agentSlug, skillsetId: dream.skillsetId, skillPath: dream.path, skillName: dream.name, skillVersion: dream.version, activateDream: true })
      } else if (!on && installed) {
        await remove.mutateAsync({ agentSlug, skillDir: installed.path })
      }
      await Promise.all([skills.refetch(), discoverable.refetch()])
    } catch (error) {
      toast.error('Could not change Self-Improvement', { description: error instanceof Error ? error.message : undefined })
    } finally {
      setChangingSkill(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="agent-addons-step">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center py-8">
        {header}
        <TooltipProvider delayDuration={200}>
          <div className="space-y-5">
            <Section title="Skills">
              <Row icon={<TrendingUp />} title="Self-Improvement" description="Installs Dream to review past work and improve between sessions."
                checked={!!installed} disabled={changingSkill} onChange={on => void toggleDream(on)}
                reason={!installed && !dream ? 'Requires Dream in the Gamut Public Skillset.' : undefined} />
            </Section>
            <Section title="Knowledge & Context">
              <Row icon={<NotebookPen />} title="Memories" description="Remembers what it learns across Claude sessions."
                checked={preferences.data?.autoMemoryEnabled !== false} disabled={!preferences.data || updatePreferences.isPending}
                onChange={autoMemoryEnabled => updatePreferences.mutate({ autoMemoryEnabled })} />
              <Row icon={<Brain />} title="Team Brain" description="Reads the shared drive and can message Team Brain."
                checked={access.everyAgent || access.isOn(agentSlug)} disabled={access.isChanging(agentSlug) || !access.ready}
                reason={!brain ? 'Set up Team Brain in this workspace first.' : access.everyAgent ? 'Team Brain is enabled by default for all agents in this workspace.' : undefined}
                onChange={on => access.toggle(agentSlug, on)} />
            </Section>
            <Section title="Channels">
              {(['platform-email', 'slack'] as const).map(slug => {
                const title = slug === 'slack' ? 'Slack' : 'Inbox'
                const rows = integrations?.filter(row => row.provider === slug)
                const configured = rows?.some(row => !needsSlackSetup(row))
                const pending = rows?.find(needsSlackSetup)
                const action = configured ? 'Configured' : pending ? 'Finish setup' : 'Set up'
                const available = providers?.some(provider => provider.provider === slug)
                return <div key={slug} className="flex items-center gap-3 px-4 py-3">
                  <Icon>{slug === 'slack' ? <ServiceIcon slug="slack" fallback="mcp" /> : <Mail />}</Icon>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-xs text-muted-foreground">{slug === 'slack' ? 'Talk to this agent in Slack.' : 'Give this agent its own email address.'}</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={configured || (!available && !pending) || !integrations}
                    aria-label={`${action} ${title}`}
                    title={!available && !pending ? `${title} is unavailable in this workspace.` : undefined}
                    onClick={() => {
                      if (pending) setResumeId(pending.id)
                      else setSetup(integrationSetupProviders.find(provider => provider.slug === slug) ?? null)
                    }}>
                    {action}
                  </Button>
                </div>
              })}
            </Section>
          </div>
        </TooltipProvider>
      </div>
      <Dialog open={!!resume} onOpenChange={open => { if (!open) setResumeId(null) }}>
        {resume && <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogTitle>Finish Slack setup</DialogTitle>
          {resume.provisionedApp ? <ProvisionedAppCard integration={resume} /> : <SlackConnectionSettings integration={resume} />}
        </DialogContent>}
      </Dialog>
      <AgentIntegrationSetupDialog agentSlug={agentSlug} provider={setup} onIntegrationCreated={() => setSetup(null)} onOpenChange={open => { if (!open) setSetup(null) }} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section>
    <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">{title}</h3>
    <div className="divide-y rounded-card border bg-card/50">{children}</div>
  </section>
}

function Icon({ children }: { children: ReactNode }) {
  return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground [&_svg]:size-4" aria-hidden>{children}</span>
}

function Row({ title, description, icon, checked, onChange, disabled, reason }: {
  title: string; description: string; icon: ReactNode; checked: boolean
  onChange: (on: boolean) => void; disabled?: boolean; reason?: string
}) {
  const id = useId()
  const [showReason, setShowReason] = useState(false)
  const inactive = !!reason || disabled
  const row = <label htmlFor={id}
    className={`flex items-center gap-3 px-4 py-3 ${inactive ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
    <Icon>{icon}</Icon>
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{description}</span>
    </span>
    {reason && checked && <span aria-hidden className="text-sm font-medium">On</span>}
    <Switch id={id} aria-label={title} checked={checked} onCheckedChange={onChange} disabled={inactive}
      className="disabled:pointer-events-none disabled:opacity-100" />
  </label>
  if (!reason) return row
  return <div className="relative">
    {row}
    <Tooltip open={showReason} onOpenChange={setShowReason}>
      <TooltipTrigger type="button" aria-label={`Why ${title} is ${checked ? 'on' : 'unavailable'}`}
        onClick={event => { event.preventDefault(); setShowReason(true) }}
        className="absolute inset-0 cursor-help rounded-item outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  </div>
}
