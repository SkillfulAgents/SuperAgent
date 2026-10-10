import { useState } from 'react'
import { ChevronLeft, Globe, Lock, Trash2 } from 'lucide-react'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { useHideSettingsHeader, useFullWidthSettingsContent } from '@renderer/components/settings/settings-page'
import { AgentAssignmentList } from '@renderer/components/agents/agent-assignment-list'
import { AppLink } from '@renderer/components/ui/app-link'
import { Button } from '@renderer/components/ui/button'
import { VolumeStatusBadge } from '@renderer/components/agents/volume-status-badge'
import { useAgents } from '@renderer/hooks/use-agents'
import { useUser } from '@renderer/context/user-context'
import { useAddMount, useRemoveMount } from '@renderer/hooks/use-mounts'
import { useSaveVolumeDefinition, useVolumeAgents } from '@renderer/hooks/use-volume-definitions'
import { VolumeDetailsFields } from './volume-setup-layout'
import { volumeDetailsSchema, type VolumeDetails } from './volume-details-schema'
import { VolumeIcon } from './volume-icon'
import { VolumeFileBrowser } from './volume-file-browser'

function VolumeAgentsList({ volume }: { volume: VolumeDefinitionSummary }) {
  const { isAuthMode, rolesReady, canUseAgent } = useUser()
  const agents = useAgents()
  const assignment = useVolumeAgents(volume.id)
  const add = useAddMount()
  const remove = useRemoveMount()
  const [changedWhileRunning, setChangedWhileRunning] = useState<Set<string>>(new Set())
  return <section className="min-w-0 space-y-3" aria-label="Volume agents">
    <p className="text-xs text-muted-foreground">Running agents pick up mount changes after a restart.</p>
    <AgentAssignmentList
      agents={(agents.data ?? []).filter(agent => !isAuthMode || (rolesReady && canUseAgent(agent.slug)))}
      assignedSlugs={(assignment.data?.attachments ?? []).map(item => item.agentSlug)}
      isLoading={agents.isLoading || assignment.isLoading || (isAuthMode && !rolesReady)} error={agents.error ?? assignment.error}
      sectioned assignedLabel="Agents With This Volume" unassignedLabel="Agents Without This Volume"
      emptyAssigned="No agents have this volume mounted. Add one below."
      toggleLabel={(agent, assigned) => `${assigned ? 'Unmount' : 'Mount'} ${volume.name} ${assigned ? 'from' : 'on'} ${agent.name}`}
      testId={slug => `volume-agent-toggle-${volume.id}-${slug}`}
      onToggle={async (slug, next) => {
        if (next) await add.mutateAsync({ agentSlug: slug, volumeId: volume.id })
        else {
          const mount = assignment.data?.attachments.find(item => item.agentSlug === slug)
          if (mount) await remove.mutateAsync({ agentSlug: slug, mountId: mount.mountId })
        }
        if (agents.data?.find(agent => agent.slug === slug)?.status === 'running') {
          setChangedWhileRunning(current => new Set(current).add(slug))
        }
      }}
      rowDescription={agent => changedWhileRunning.has(agent.slug) && agents.data?.find(item => item.slug === agent.slug)?.status === 'running'
        ? <AppLink to="/agents/$slug" params={{ slug: agent.displaySlug }} className="text-[11px] text-orange-600 dark:text-orange-400 hover:underline">Restart agent to apply changes</AppLink> : null}
    />
  </section>
}

function VolumeSettingsForm({ volume, onDelete }: { volume: VolumeDefinitionSummary; onDelete: () => void }) {
  const save = useSaveVolumeDefinition()
  const [details, setDetails] = useState<VolumeDetails>({ name: volume.name, visibility: volume.userId === null ? 'public' : 'private' })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const submit = async () => {
    setError(null); setSaved(false)
    const input = volumeDetailsSchema.safeParse(details)
    if (!input.success) { setError(input.error.issues[0].message); return }
    try { await save.mutateAsync({ id: volume.id, ...input.data }); setSaved(true) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save volume') }
  }
  return <section className="space-y-2">
    <h3 className="text-xs font-normal text-muted-foreground">Settings</h3>
    <form className="rounded-xl border bg-background p-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
      <VolumeDetailsFields value={details} onChange={next => { setDetails(next); setSaved(false); setError(null) }} disabled={save.isPending} inUse={volume.attachmentCount > 0}>
        <div className="space-y-1"><p className="text-sm font-medium">Folder</p><p className="break-all text-xs text-muted-foreground" data-testid="selected-volume-folder">{volume.sourceLabel ?? volume.hostPath}</p></div>
      </VolumeDetailsFields>
      <p className="text-xs text-muted-foreground">Renaming this volume keeps existing agents’ mount paths.</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onDelete}
          disabled={save.isPending || volume.attachmentCount > 0} title={volume.attachmentCount > 0 ? 'Detach from all agents before deleting' : undefined}>
          <Trash2 className="h-3.5 w-3.5" />Delete volume
        </Button>
        <span className="flex-1 text-xs text-muted-foreground" role="status">{saved ? 'Saved' : ''}</span>
        <Button type="submit" size="sm" disabled={save.isPending || !details.name.trim()}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </form>
  </section>
}

export function VolumeDetailPage({ volume, onBack, onDelete }: { volume: VolumeDefinitionSummary; onBack: () => void; onDelete: () => void }) {
  useHideSettingsHeader(true)
  useFullWidthSettingsContent(true)
  return <div className="space-y-4 w-full max-w-6xl mx-auto" data-testid="volume-detail-page">
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"><ChevronLeft className="h-3.5 w-3.5 mr-1" />Volumes</Button>
    <div className="flex items-center gap-3">
      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0"><VolumeIcon type={volume.type} className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><h2 className="text-base font-medium truncate">{volume.name}</h2><VolumeStatusBadge health={volume.health} /></div>
        <p className="text-xs text-muted-foreground truncate">{volume.sourceLabel ?? volume.hostPath}</p>
      </div>
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{volume.userId === null ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{volume.userId === null ? 'Public' : 'Private'}</span>
    </div>
    <div className="grid gap-6 items-start grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] pt-4">
      <div className="min-w-0 space-y-6">
        <VolumeAgentsList volume={volume} />
        {volume.canManage && <VolumeSettingsForm volume={volume} onDelete={onDelete} />}
      </div>
      <VolumeFileBrowser volumeId={volume.id} />
    </div>
  </div>
}
