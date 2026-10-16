import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, Globe, Lock, X } from 'lucide-react'
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
import { InlineEditableTitle } from '@renderer/components/ui/inline-editable-title'
import { VolumeDetailsFields } from './volume-setup-layout'
import { parseVolumeName, type VolumeDetails } from './volume-details-schema'
import { VolumeIcon } from './volume-icon'
import { VolumeFileBrowser } from './volume-file-browser'

function VolumeAgentsList({ volume }: { volume: VolumeDefinitionSummary }) {
  const { isAuthMode, rolesReady, canUseAgent } = useUser()
  const agents = useAgents()
  const assignment = useVolumeAgents(volume.id)
  const add = useAddMount()
  const remove = useRemoveMount()
  const [changedWhileRunning, setChangedWhileRunning] = useState<Set<string>>(new Set())
  return <section className="min-w-0 space-y-3" aria-label="Drive agents">
    <p className="text-xs text-muted-foreground">Running agents pick up drive changes after a restart.</p>
    <AgentAssignmentList
      agents={(agents.data ?? []).filter(agent => !isAuthMode || (rolesReady && canUseAgent(agent.slug)))}
      assignedSlugs={(assignment.data?.attachments ?? []).map(item => item.agentSlug)}
      isLoading={agents.isLoading || assignment.isLoading || (isAuthMode && !rolesReady)} error={agents.error ?? assignment.error}
      sectioned assignedLabel="Agents With This Drive" unassignedLabel="Agents Without This Drive"
      emptyAssigned="No agents have this drive. Add one below."
      toggleLabel={(agent, assigned) => `${assigned ? 'Remove' : 'Add'} ${volume.name} ${assigned ? 'from' : 'to'} ${agent.name}`}
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
  const { isAuthMode, isAdmin } = useUser()
  const save = useSaveVolumeDefinition()
  const [visibility, setVisibility] = useState<VolumeDetails['visibility']>(volume.userId === null ? 'public' : 'private')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const submit = async () => {
    setError(null); setSaved(false)
    try { await save.mutateAsync({ id: volume.id, visibility }); setSaved(true) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save drive') }
  }
  return <section className="space-y-2">
    <h3 className="text-xs font-normal text-muted-foreground">Settings</h3>
    <form className="rounded-xl border bg-background p-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
      <VolumeDetailsFields showName={false} value={{ name: volume.name, visibility }} onChange={next => { setVisibility(next.visibility); setSaved(false); setError(null) }} disabled={save.isPending} inUse={volume.attachmentCount > 0}>
        <div className="space-y-1"><p className="text-sm font-medium">Folder</p><p className="break-all text-xs text-muted-foreground" data-testid="selected-volume-folder">{volume.sourceLabel ?? volume.hostPath}</p></div>
      </VolumeDetailsFields>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-destructive" onClick={onDelete}
          disabled={save.isPending || volume.attachmentCount > 0} title={volume.attachmentCount > 0 ? 'Remove from all agents first' : undefined}>
          <X className="h-3.5 w-3.5" />Remove drive
        </Button>
        <span className="flex-1 text-xs text-muted-foreground" role="status">{saved ? 'Saved' : ''}</span>
        {isAuthMode && isAdmin && volume.attachmentCount === 0 && <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>}
      </div>
    </form>
  </section>
}

export function VolumeDetailPage({ volume, onBack, backLabel = 'Drives', onDelete }: { volume: VolumeDefinitionSummary; onBack: () => void; backLabel?: string; onDelete: () => void }) {
  useHideSettingsHeader(true)
  useFullWidthSettingsContent(true)
  const save = useSaveVolumeDefinition()
  return <div className="space-y-4 w-full max-w-6xl mx-auto" data-testid="volume-detail-page">
    <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"><ChevronLeft className="h-3.5 w-3.5 mr-1" />{backLabel}</Button>
    <div className="flex items-center gap-3">
      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0"><VolumeIcon type={volume.type} className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <InlineEditableTitle
            value={volume.name}
            canEdit={volume.canManage}
            isSaving={save.isPending}
            onSave={async name => { await save.mutateAsync({ id: volume.id, name: parseVolumeName(name) }) }}
            onError={error => {
              toast.error('Failed to rename drive', { description: error instanceof Error ? error.message : 'Please try again.' })
            }}
            readOnlyAs="h2"
            displayClassName="text-base font-medium"
            inputClassName="h-8 text-base font-medium"
            saveButtonClassName="h-7 w-7"
            ariaLabel="Rename drive"
            saveAriaLabel="Save name"
            displayTestId="volume-title"
            inputTestId="volume-title-input"
          />
          <VolumeStatusBadge health={volume.health} />
        </div>
        <p className="text-xs text-muted-foreground truncate">{volume.sourceLabel ?? volume.hostPath}</p>
        {volume.canManage && volume.attachmentCount > 0 && <p className="text-xs text-muted-foreground">Renaming this drive keeps existing agents’ folder paths.</p>}
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
