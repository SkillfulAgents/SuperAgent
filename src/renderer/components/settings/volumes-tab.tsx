import { useState } from 'react'
import { Folder, FolderOpen, Globe, Loader2, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { useDeleteVolumeDefinition, useSaveVolumeDefinition, useVolumeDefinitions } from '@renderer/hooks/use-volume-definitions'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@renderer/components/ui/alert-dialog'
import { VolumeStatusBadge } from '@renderer/components/agents/volume-status-badge'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'

export function VolumesTab() {
  const registry = useVolumeDefinitions()
  const remove = useDeleteVolumeDefinition()
  const [editing, setEditing] = useState<VolumeDefinitionSummary | 'new' | null>(null)
  const [deleting, setDeleting] = useState<VolumeDefinitionSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const definitions = registry.data ?? []

  const deleteVolume = async () => {
    if (!deleting) return
    try {
      setError(null)
      await remove.mutateAsync(deleting.id)
      setDeleting(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete volume')
    }
  }

  return (
    <div className="space-y-6" data-testid="volumes-settings">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">Save folders once, then attach them to any of your agents from their Volumes card.</p>
        {canUseHostFeatures() && <Button size="sm" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add volume</Button>}
      </div>
      {(error || registry.error) && <p role="alert" className="text-sm text-destructive">{error ?? 'Could not load volumes. Please try again.'}</p>}
      {registry.isLoading ? <p className="text-sm text-muted-foreground" role="status">Loading volumes…</p> : definitions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Folder className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <p className="text-sm font-medium">No saved volumes</p>
          <p className="mt-1 text-sm text-muted-foreground">Folders you mount on an agent are saved here for reuse.</p>
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {definitions.map(volume => (
            <div key={volume.id} className="flex items-center gap-3 p-4" data-testid="saved-volume-row">
              <Folder className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{volume.name}</span>
                  <VolumeStatusBadge health={volume.health} />
                </div>
                {volume.hostPath && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={volume.hostPath}>{volume.hostPath}</p>}
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">{volume.userId === null ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}{volume.userId === null ? 'Public' : 'Private'}</span>
                  <span>{volume.attachmentCount === 0 ? 'Not attached' : `Used by ${volume.attachmentCount} ${volume.attachmentCount === 1 ? 'agent' : 'agents'}`}</span>
                </div>
              </div>
              {volume.canManage && <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={`Edit ${volume.name}`} onClick={() => setEditing(volume)}><Pencil className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" aria-label={`Delete ${volume.name}`} disabled={volume.attachmentCount > 0}
                  title={volume.attachmentCount > 0 ? 'Detach from all agents before deleting' : 'Delete saved volume'}
                  onClick={() => { setError(null); setDeleting(volume) }}><Trash2 className="h-4 w-4" /></Button>
              </div>}
            </div>
          ))}
        </div>
      )}
      {editing && <VolumeSettingsDialog volume={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <AlertDialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved volume?</AlertDialogTitle>
            <AlertDialogDescription>Remove &quot;{deleting?.name}&quot; from saved volumes. The folder and its files will stay on disk.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={event => { event.preventDefault(); void deleteVolume() }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{remove.isPending ? 'Deleting…' : 'Delete volume'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function VolumeSettingsDialog({ volume, onClose }: { volume?: VolumeDefinitionSummary; onClose: () => void }) {
  const { isAuthMode, isAdmin } = useUser()
  const [name, setName] = useState(volume?.name ?? '')
  const [folder, setFolder] = useState(volume?.hostPath ?? '')
  const [visibility, setVisibility] = useState<'private' | 'public'>(volume ? volume.userId === null ? 'public' : 'private' : isAuthMode ? 'private' : 'public')
  const [error, setError] = useState<string | null>(null)
  const save = useSaveVolumeDefinition()
  const inUse = (volume?.attachmentCount ?? 0) > 0

  const chooseFolder = async () => {
    if (!canUseHostFeatures()) return
    try {
      const selected = await window.electronAPI?.openDirectory()
      if (!selected) return
      setFolder(selected)
      if (!name) setName(selected.split(/[/\\]/).filter(Boolean).at(-1) ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker')
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      await save.mutateAsync({ id: volume?.id, name, path: volume ? undefined : folder, visibility })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save volume')
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="volume-settings-dialog">
        <DialogHeader>
          <DialogTitle>{volume ? 'Volume settings' : 'Add volume'}</DialogTitle>
          <DialogDescription>{volume ? 'Manage this saved volume. Existing agents keep their current mount paths.' : 'Choose a folder to make available to your agents. Attached agents get read/write access.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="volume-name">Name</Label>
            <Input id="volume-name" value={name} onChange={event => setName(event.target.value)} maxLength={255} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="volume-folder">Folder</Label>
            <div className="flex gap-2">
              <Input id="volume-folder" value={folder} readOnly placeholder="Choose a folder" className="font-mono text-xs" />
              {!volume && canUseHostFeatures() && <Button type="button" variant="outline" onClick={() => { void chooseFolder() }}><FolderOpen className="h-4 w-4" />Browse</Button>}
            </div>
          </div>
          {isAuthMode && <div className="space-y-2">
            <Label htmlFor="volume-access">Who can attach this volume?</Label>
            {isAdmin ? (
              <Select value={visibility} onValueChange={value => setVisibility(value as 'public' | 'private')} disabled={inUse}>
                <SelectTrigger id="volume-access"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="private">Only me</SelectItem><SelectItem value="public">Everyone</SelectItem></SelectContent>
              </Select>
            ) : <p className="text-sm">Only me</p>}
            {inUse && isAdmin && <p className="text-xs text-muted-foreground">Detach from all agents before changing access.</p>}
          </div>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || (!volume && !folder) || save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}{volume ? 'Save changes' : 'Add volume'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
