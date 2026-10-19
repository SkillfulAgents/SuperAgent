import { useState } from 'react'
import { toast } from 'sonner'
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
import { useMyAgentsPreview, useSaveVolumeDefinition, useSetMyAgentDrive, useVolumeAgents } from '@renderer/hooks/use-volume-definitions'
import { useUserSettings } from '@renderer/hooks/use-user-settings'
import { Switch } from '@renderer/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@renderer/components/ui/alert-dialog'
import type { MyAgentDrive } from '@shared/lib/services/user-settings-service'
import { InlineEditableTitle } from '@renderer/components/ui/inline-editable-title'
import { VolumeDetailsFields } from './volume-setup-layout'
import { parseVolumeName, type VolumeDetails } from './volume-details-schema'
import { VolumeIcon } from './volume-icon'
import { VolumeFileBrowser } from './volume-file-browser'

const LEVEL_LABEL: Record<MyAgentDrive['level'], string> = { read: 'Read-only', write: 'Can write' }
// A picker that reads as a word in the sentence.
const INLINE_PICKER = 'h-auto w-auto gap-0.5 border-0 bg-transparent p-0 text-sm font-medium shadow-none underline decoration-dotted decoration-muted-foreground underline-offset-4 focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring inline-flex'

function MyAgentsSetting({ volume }: { volume: VolumeDefinitionSummary }) {
  const { isAuthMode } = useUser()
  const settings = useUserSettings()
  const set = useSetMyAgentDrive(volume.id)
  const current = settings.data?.myAgentDrives?.[volume.id] ?? null
  const [draft, setDraft] = useState<MyAgentDrive>(current ?? { level: 'read', shared: false })
  const [confirming, setConfirming] = useState<MyAgentDrive | null>(null)
  const shown = current ?? draft
  const preview = useMyAgentsPreview(volume.id, confirming ? confirming.shared : null)
  const change = (next: MyAgentDrive) => { setDraft(next); if (current) setConfirming(next) }
  // Only a fresh preview counts: a cached one may name agents that changed since.
  const ready = preview.isSuccess && !preview.isFetching
  const count = preview.data?.agents ?? 0
  const sharedAgents = preview.data?.sharedAgents ?? []
  return <div className="space-y-2" data-testid="my-agents-setting">
    <div className="flex items-start gap-3">
      <p className="min-w-0 flex-1 text-sm font-medium leading-6">
        Add to all my{' '}
        {isAuthMode ? <Select value={shown.shared ? 'shared' : 'private'} disabled={set.isPending}
          onValueChange={value => change({ ...shown, shared: value === 'shared' })}>
          <SelectTrigger className={INLINE_PICKER} aria-label="Which of my agents"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="private">private</SelectItem>
            <SelectItem value="shared">owned</SelectItem>
          </SelectContent>
        </Select> : null}{' '}
        agents as{' '}
        <Select value={shown.level} disabled={set.isPending}
          onValueChange={value => { if (value === 'read' || value === 'write') change({ ...shown, level: value }) }}>
          <SelectTrigger className={INLINE_PICKER} aria-label="Access on my agents"><SelectValue /></SelectTrigger>
          <SelectContent>{(['read', 'write'] as const).map(item => <SelectItem key={item} value={item}>{LEVEL_LABEL[item]}</SelectItem>)}</SelectContent>
        </Select>
      </p>
      <Switch className="mt-0.5 shrink-0" aria-label="Add to all my agents" checked={current !== null} disabled={set.isPending || settings.isLoading}
        onCheckedChange={on => { if (on) setConfirming(draft); else { setDraft(current ?? draft); set.mutate(null) } }} />
    </div>
    <p className="text-xs text-muted-foreground">
      {current
        ? 'Turning this off stops adding it to new agents. Agents that have it keep it.'
        : shown.shared
          ? 'Adds this drive to every agent you own, including shared ones, now and when you create one.'
          : 'Adds this drive to agents only you use, now and when you create one.'}
    </p>
    {shown.level === 'write' && <p className="text-xs text-orange-600 dark:text-orange-400">These agents can edit and delete files in this drive.</p>}
    <AlertDialog open={confirming !== null} onOpenChange={open => { if (!open) { setConfirming(null); setDraft(current ?? draft) } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Set {volume.name} to {confirming ? LEVEL_LABEL[confirming.level] : ''} on {ready ? `${count} ${count === 1 ? 'agent' : 'agents'}` : 'your agents'}?</AlertDialogTitle>
          <AlertDialogDescription>
            {preview.isError ? 'Could not count your agents. Cancel and try again.' : !ready ? 'Counting your agents…' : <>
              Replaces access set on them by hand{confirming?.shared && sharedAgents.length > 0 ? ', including by teammates' : ''}. New agents get it too.
              {confirming?.shared && sharedAgents.length > 0 && <> Teammates can {confirming.level === 'write' ? 'edit' : 'read'} it on {sharedAgents.join(', ')}.</>}
            </>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="my-agents-confirm" disabled={!ready} onClick={() => { const next = confirming; setConfirming(null); if (next) set.mutate(next) }}>
            Set
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

function VolumeAgentsList({ volume }: { volume: VolumeDefinitionSummary }) {
  const { isAuthMode, rolesReady, canUseAgent } = useUser()
  const agents = useAgents()
  const assignment = useVolumeAgents(volume.id)
  const add = useAddMount()
  const remove = useRemoveMount()
  return <section className="min-w-0 space-y-3" aria-label="Drive agents">
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
      }}
      rowDescription={agent => agents.data?.some(item => item.slug === agent.slug && item.status === 'running' && item.stale)
        ? <AppLink to="/agents/$slug" params={{ slug: agent.displaySlug }} className="text-[11px] text-orange-600 dark:text-orange-400 hover:underline">Restart agent to apply changes</AppLink> : null}
    />
  </section>
}

function VolumeSettingsForm({ volume }: { volume: VolumeDefinitionSummary }) {
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
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
    <VolumeDetailsFields showName={false} value={{ name: volume.name, visibility }} onChange={next => { setVisibility(next.visibility); setSaved(false); setError(null) }} disabled={save.isPending} inUse={volume.attachmentCount > 0}>
      <div className="space-y-1"><p className="text-sm font-medium">Folder</p><p className="break-all text-xs text-muted-foreground" data-testid="selected-volume-folder">{volume.sourceLabel ?? volume.hostPath}</p></div>
    </VolumeDetailsFields>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {isAuthMode && isAdmin && volume.attachmentCount === 0 && <div className="flex items-center gap-2">
      <span className="flex-1 text-xs text-muted-foreground" role="status">{saved ? 'Saved' : ''}</span>
      <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
    </div>}
  </form>
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
        <section className="space-y-2">
          <h3 className="text-xs font-normal text-muted-foreground">Settings</h3>
          <div className="rounded-xl border bg-background p-4 space-y-4">
            {volume.canManage && <VolumeSettingsForm volume={volume} />}
            <div className={volume.canManage ? 'border-t pt-4' : undefined}><MyAgentsSetting volume={volume} /></div>
            {volume.canManage && <div className="border-t pt-3">
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onDelete}
                disabled={volume.attachmentCount > 0} title={volume.attachmentCount > 0 ? 'Remove from all agents before deleting' : undefined}>
                <Trash2 className="h-3.5 w-3.5" />Delete drive
              </Button>
            </div>}
          </div>
        </section>
        <VolumeAgentsList volume={volume} />
      </div>
      <VolumeFileBrowser volumeId={volume.id} />
    </div>
  </div>
}
