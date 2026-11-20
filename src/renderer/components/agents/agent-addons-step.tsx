import { useEffect, useId, useState, type ReactNode } from 'react'
import { Brain, NotebookPen, TrendingUp } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@renderer/components/ui/switch'
import { AgentCreationChannels } from './agent-creation-channels'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useAgents } from '@renderer/hooks/use-agents'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useAgentSkills, useDiscoverableSkills, useDeleteSkill, useInstallSkill } from '@renderer/hooks/use-agent-skills'
import { useAgentTeamBrainAccess } from '@renderer/hooks/use-team-brain-access'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import { DREAM_SKILL_PATH, isPublicDreamSkill } from '@shared/lib/skillset-provider/dream-skill'

export function AgentAddonsStep({ header, agentSlug, onBusyChange, onDreamChange }: {
  header: ReactNode
  agentSlug: string
  onBusyChange: (busy: boolean) => void
  onDreamChange: (enabled: boolean) => void
}) {
  const skills = useAgentSkills(agentSlug)
  const discoverable = useDiscoverableSkills(agentSlug)
  const install = useInstallSkill()
  const remove = useDeleteSkill()
  const preferences = useAgentPreferences(agentSlug)
  const updatePreferences = useUpdateAgentPreferences(agentSlug)
  const { data: agents } = useAgents()
  const brain = agents?.find(agent => agent.teamBrain)
  const access = useAgentTeamBrainAccess(agentSlug, brain?.slug ?? '', brain?.teamBrain?.volumeId)
  const [changingSkill, setChangingSkill] = useState(false)

  const dream = discoverable.data?.find(s => s.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && s.path === DREAM_SKILL_PATH)
  const installed = skills.data?.find(isPublicDreamSkill)
  useEffect(() => {
    if (skills.data) onDreamChange(!!installed)
  }, [skills.data, installed, onDreamChange])
  const dreamReason = installed || dream ? undefined
    : discoverable.isError ? 'Could not load the Gamut Public Skillset. Try again.'
    : discoverable.data && skills.data ? 'Requires Dream in the Gamut Public Skillset.' : undefined
  const busy = changingSkill || updatePreferences.isPending || access.changing
  useEffect(() => {
    onBusyChange(busy)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])

  async function toggleDream(on: boolean) {
    setChangingSkill(true)
    try {
      if (on && dream) {
        await install.mutateAsync({ agentSlug, skillsetId: dream.skillsetId, skillPath: dream.path, skillName: dream.name, skillVersion: dream.version })
      } else if (!on && installed) {
        await remove.mutateAsync({ agentSlug, skillDir: installed.path })
      }
      onDreamChange(on)
      await Promise.all([skills.refetch(), discoverable.refetch()])
    } catch (error) {
      toast.error('Could not change Self-Improvement', { description: error instanceof Error ? error.message : undefined })
    } finally {
      setChangingSkill(false)
    }
  }

  return (
    // 8px either side for focus rings at the column's edge (More's sits 6px
    // out, plus its 2px ring): a scroller clips sideways too.
    <div className="-mx-2 h-full overflow-y-auto px-2" data-testid="agent-addons-step">
      <div className="flex min-h-full w-full flex-col justify-center py-8">
        {header}
        <TooltipProvider delayDuration={200}>
          <div className="space-y-5">
            <Section title="Skills">
              <Row icon={<TrendingUp />} title="Self-Improvement" description="Install a dreaming skill to review past work and improve between sessions."
                checked={!!installed} disabled={changingSkill || !skills.data || (!installed && !dream)} onChange={on => void toggleDream(on)}
                reason={dreamReason} />
              {(discoverable.isError || skills.isError) && <Button size="sm" variant="ghost" onClick={() => {
                void skills.refetch()
                void discoverable.refetch()
              }}>Retry loading skills</Button>}
            </Section>
            <Section title="Knowledge & Context">
              <Row icon={<NotebookPen />} title="Memories" description="Remembers what it learns across sessions."
                checked={preferences.data?.autoMemoryEnabled !== false} disabled={!preferences.data || updatePreferences.isPending}
                onChange={autoMemoryEnabled => updatePreferences.mutate({ autoMemoryEnabled })} />
              <Row icon={<Brain />} title="Team Brain" description="Reads the shared drive. Team Brain can read its sessions."
                checked={access.checked} disabled={access.changing || !access.ready}
                reason={access.reason} onChange={access.toggle} />
              {access.partial && <div className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="flex-1 text-xs text-muted-foreground">Team Brain setup is incomplete.</span>
                <Button variant="outline" size="sm" disabled={!!access.reason} onClick={() => access.toggle(true)}>Finish setup</Button>
                <Button variant="ghost" size="sm" disabled={!!access.reason} onClick={() => access.toggle(false)}>Remove access</Button>
              </div>}
            </Section>
            <Section title="Channels" bare>
              <AgentCreationChannels agentSlug={agentSlug} />
            </Section>
          </div>
        </TooltipProvider>
      </div>
    </div>
  )
}

/**
 * A titled group of add-ons. Its rows go in a card; `bare` hands the
 * children the whole area instead, for a section laid out its own way
 * (Channels' grid of tiles and its More).
 */
function Section({ title, bare = false, children }: { title: string; bare?: boolean; children: ReactNode }) {
  return <section>
    <h3 className="mb-2 text-xs font-normal text-muted-foreground/70">{title}</h3>
    {bare ? children : <div className="divide-y rounded-card border bg-card/50">{children}</div>}
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
      <span className="block text-sm font-normal">{title}</span>
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
