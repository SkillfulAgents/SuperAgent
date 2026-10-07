import { useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import type { VolumeSettingsInput } from '@renderer/hooks/use-volume-definitions'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'

interface VolumeSettingsDialogProps {
  volume?: VolumeDefinitionSummary
  attachToAgent?: boolean
  onSave: (input: VolumeSettingsInput) => Promise<unknown>
  onClose: () => void
}

export function VolumeSettingsDialog({ volume, attachToAgent = false, onSave, onClose }: VolumeSettingsDialogProps) {
  const { isAuthMode, isAdmin } = useUser()
  const [name, setName] = useState(volume?.name ?? '')
  const [folder, setFolder] = useState(volume?.hostPath ?? '')
  const [visibility, setVisibility] = useState<'private' | 'public'>(volume ? volume.userId === null ? 'public' : 'private' : isAuthMode ? 'private' : 'public')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const canBrowse = canUseHostFeatures()
  const inUse = (volume?.attachmentCount ?? 0) > 0

  const selectFolder = (selected: string) => {
    setFolder(selected)
    if (!name) setName(selected.split(/[/\\]/).filter(Boolean).at(-1) ?? '')
    setError(null)
  }

  const chooseFolder = async () => {
    if (!canBrowse) return
    try {
      const selected = await window.electronAPI?.openDirectory()
      if (!selected) return
      selectFolder(selected)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker')
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setIsSaving(true)
    try {
      await onSave({ name, path: volume ? undefined : folder, visibility })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save volume')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !isSaving) onClose() }}>
      <DialogContent className="sm:max-w-lg" data-testid="volume-settings-dialog">
        <DialogHeader>
          <DialogTitle>{volume ? 'Volume settings' : 'New Volume'}</DialogTitle>
          <DialogDescription>{volume ? 'Manage this saved volume. Existing agents keep their current mount paths.' : attachToAgent ? 'Create a saved volume and attach it to this agent with read/write access.' : 'Create a saved volume to make available to your agents. Attached agents get read/write access.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="volume-name">Name</Label>
            <Input id="volume-name" value={name} onChange={event => setName(event.target.value)} maxLength={255} required />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium leading-none">Folder</p>
            {!volume && <Button id="volume-folder" type="button" variant="outline" className="w-full justify-start" onClick={() => { void chooseFolder() }} disabled={!canBrowse || isSaving}>
              <FolderOpen className="h-4 w-4" />{folder ? 'Change folder' : 'Select folder'}
            </Button>}
            {folder && <p className="break-all font-mono text-xs text-muted-foreground" data-testid="selected-volume-folder">{folder}</p>}
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
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || (!volume && !folder) || isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}{volume ? 'Save changes' : attachToAgent ? 'Create and attach' : 'Create volume'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
