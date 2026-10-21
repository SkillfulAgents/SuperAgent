import { useState } from 'react'
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { VolumeDetailPage } from '@renderer/components/volumes/volume-detail-page'
import { VolumeIcon } from '@renderer/components/volumes/volume-icon'
import { IntegrationList, IntegrationRow, RowHoverChevron } from '@renderer/components/connections/integration-row'
import { Folder, Globe, Lock, Plus, Trash2 } from 'lucide-react'
import { useDeleteVolumeDefinition, useSaveVolumeDefinition, useVolumeDefinitions } from '@renderer/hooks/use-volume-definitions'
import { Button } from '@renderer/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@renderer/components/ui/alert-dialog'
import { VolumeSettingsDialog } from '@renderer/components/volumes/volume-settings-dialog'
import { VolumeStatusBadge } from '@renderer/components/agents/volume-status-badge'
import { useAgents } from '@renderer/hooks/use-agents'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'

export function agentBackPath(source: 'home' | 'list' | undefined, from: string | undefined): string | null {
  return source === 'home' && from && /^\/agents\/[^/?#]+$/.test(from) ? from : null
}

export function VolumesTab() {
  const registry = useVolumeDefinitions()
  const remove = useDeleteVolumeDefinition()
  const save = useSaveVolumeDefinition()
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()
  const router = useRouter()
  const { volume: selectedId, source, from } = useSearch({ strict: false }) as { volume?: string; source?: 'home' | 'list'; from?: string }
  const agents = useAgents()
  const backToList = () => { void navigate({ to: '/settings/$tab', params: { tab: 'volumes' }, search: prev => ({ ...prev, volume: undefined, source: undefined }) }) }
  const openVolume = (id: string) => { void navigate({ to: '/settings/$tab', params: { tab: 'volumes' }, search: prev => ({ ...prev, volume: id, source: undefined }) }) }
  const agentPath = agentBackPath(source, from)
  const homeAgent = agents.data?.find(agent => agentPath === `/agents/${encodeURIComponent(agent.slug)}`)
  const back = agentPath
    ? { onBack: () => router.history.push(agentPath), label: homeAgent?.name ?? 'Agent' }
    : { onBack: backToList, label: undefined }
  const [deleting, setDeleting] = useState<VolumeDefinitionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const definitions = registry.data ?? []
  const selectedVolume = definitions.find(volume => volume.id === selectedId)

  const deleteVolume = async () => {
    if (!deleting) return
    try {
      setError(null)
      await remove.mutateAsync(deleting.id)
      setDeleting(null)
      if (selectedId === deleting.id) backToList()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete drive')
    }
  }

  return (
    <div className="space-y-6" data-testid="volumes-settings">
      {selectedId ? selectedVolume ? <VolumeDetailPage key={selectedVolume.id} volume={selectedVolume} onBack={back.onBack} backLabel={back.label} onDelete={() => { setError(null); setDeleting(selectedVolume) }} />
        : <div className="space-y-3"><Button variant="ghost" onClick={back.onBack}>Back to {back.label ?? 'drives'}</Button><p role={registry.isLoading ? 'status' : 'alert'} className="text-sm text-muted-foreground">{registry.isLoading ? 'Loading drive…' : registry.error ? 'Could not load this drive. Please try again.' : 'This drive is no longer available.'}</p></div>
        : <>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">Save folders once, then add them to any of your agents from their Drives card.</p>
        <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Add drive</Button>
      </div>
      {(error || registry.error) && <p role="alert" className="text-sm text-destructive">{error ?? 'Could not load drives. Please try again.'}</p>}
      {registry.isLoading ? <p className="text-sm text-muted-foreground" role="status">Loading drives…</p> : definitions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Folder className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <p className="text-sm font-medium">No saved drives</p>
          <p className="mt-1 text-sm text-muted-foreground">Folders you add to an agent are saved here for reuse.</p>
        </div>
      ) : (
        <IntegrationList>
          {definitions.map(volume => (
            <IntegrationRow key={volume.id} data-testid="saved-volume-row"
              icon={<VolumeIcon type={volume.type} className="h-4 w-4 text-muted-foreground" />}
              name={volume.name}
              nameBadge={<VolumeStatusBadge health={volume.health} />}
              subtitle={<>
                {(volume.sourceLabel ?? volume.hostPath) && <span className="min-w-0 truncate font-mono" title={volume.sourceLabel ?? volume.hostPath ?? undefined}>{volume.sourceLabel ?? volume.hostPath}</span>}
                {(volume.sourceLabel ?? volume.hostPath) && <span className="shrink-0">·</span>}
                <span className="inline-flex shrink-0 items-center gap-1">{volume.userId === null ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}{volume.userId === null ? 'Public' : 'Private'}</span>
                <span className="shrink-0">·</span>
                <span className="shrink-0">{volume.globalAccess ? 'Every agent' : volume.attachmentCount === 0 ? 'Not added' : `Used by ${volume.attachmentCount} ${volume.attachmentCount === 1 ? 'agent' : 'agents'}`}</span>
              </>}
              onActivate={() => openVolume(volume.id)}
              ariaLabel={`Open ${volume.name} drive settings`}
              right={<>
                {volume.canManage && <Button variant="ghost" size="icon" aria-label={`Delete ${volume.name}`} disabled={volume.attachmentCount > 0}
                  title={volume.attachmentCount > 0 ? 'Remove from all agents before deleting' : 'Delete saved drive'}
                  onClick={event => { event.stopPropagation(); setError(null); setDeleting(volume) }}><Trash2 className="h-4 w-4" /></Button>}
                <RowHoverChevron />
              </>}
            />
          ))}
        </IntegrationList>
      )}
      </>}
      {creating && <VolumeSettingsDialog
        onSave={input => save.mutateAsync(input)}
        onClose={() => setCreating(false)}
      />}
      <AlertDialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved drive?</AlertDialogTitle>
            <AlertDialogDescription>Remove &quot;{deleting?.name}&quot; from saved drives. The source folder and its files will remain unchanged.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={event => { event.preventDefault(); void deleteVolume() }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{remove.isPending ? 'Deleting…' : 'Delete drive'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
