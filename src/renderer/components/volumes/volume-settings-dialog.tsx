import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import type { VolumeSettingsInput } from '@renderer/hooks/use-volume-definitions'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'
import { volumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { volumeDetailsSchema, type VolumeDetails } from './volume-details-schema'
import { VolumeDetailsFields, VolumeSetupFooter } from './volume-setup-layout'
import { volumeSetupRegistry } from './volume-setup-registry'
import type { VolumeSetupDefinition } from './volume-setup'

interface VolumeSettingsDialogProps {
  volume?: VolumeDefinitionSummary
  attachToAgent?: boolean
  onSave: (input: VolumeSettingsInput) => Promise<unknown>
  onClose: () => void
}

export function VolumeSettingsDialog({ volume, attachToAgent = false, onSave, onClose }: VolumeSettingsDialogProps) {
  const { isAuthMode } = useUser()
  const [details, setDetails] = useState<VolumeDetails>({
    name: volume?.name ?? '',
    visibility: volume ? volume.userId === null ? 'public' : 'private' : isAuthMode ? 'private' : 'public',
  })
  const [selected, setSelected] = useState<{ definition: VolumeSetupDefinition; config: unknown } | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const selectSource = async (definition: VolumeSetupDefinition) => {
    if (!definition.isAvailable() || starting) return
    setError(null)
    setStarting(definition.type)
    try {
      const config = await definition.begin?.()
      if (config !== null) setSelected({ definition, config })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not select this source')
    } finally { setStarting(null) }
  }

  const save = async (values: VolumeDetails, config?: unknown) => {
    if (isSaving) return
    setError(null)
    const parsedDetails = volumeDetailsSchema.safeParse(values)
    if (!parsedDetails.success) { setError(parsedDetails.error.issues[0].message); return }
    setIsSaving(true)
    try {
      const source = selected ? volumeConfigSchema.parse({ type: selected.definition.type, config: selected.definition.configSchema.parse(config) }) : undefined
      await onSave({ ...parsedDetails.data, ...(source ? { source } : {}) })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save volume')
    } finally { setIsSaving(false) }
  }

  const Setup = selected?.definition.Setup
  return <Dialog open onOpenChange={open => { if (!open && !isSaving && !starting) onClose() }}>
    <DialogContent className="sm:max-w-lg" data-testid="volume-settings-dialog">
      {volume ? <>
        <DialogHeader><DialogTitle>Volume settings</DialogTitle><DialogDescription>Manage this saved volume. Existing agents keep their current mount paths.</DialogDescription></DialogHeader>
        <form onSubmit={event => { event.preventDefault(); void save(details) }} className="space-y-4">
          <VolumeDetailsFields value={details} onChange={value => { setDetails(value); setError(null) }} disabled={isSaving} inUse={volume.attachmentCount > 0}>
            <div className="space-y-2"><p className="text-sm font-medium">Folder</p><p className="break-all font-mono text-xs text-muted-foreground" data-testid="selected-volume-folder">{volume.sourceLabel ?? volume.hostPath}</p></div>
          </VolumeDetailsFields>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <VolumeSetupFooter onCancel={onClose} isSaving={isSaving} disabled={!details.name.trim()} submitLabel="Save changes" />
        </form>
      </> : Setup ? <Setup initialConfig={selected?.config} initialDetails={details} onSubmit={(config, values) => save(values, config)}
        onBack={() => { setSelected(null); setError(null) }} onCancel={onClose} isSaving={isSaving} error={error} clearError={() => setError(null)} attachToAgent={attachToAgent} /> : <>
        <DialogHeader className="text-left">
          <DialogTitle>New Volume</DialogTitle>
          <DialogDescription>Choose where your files live.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3" aria-label="Volume sources">
          {Object.values(volumeSetupRegistry).map(definition => {
            const available = definition.isAvailable()
            return <button key={definition.type} type="button" aria-label={definition.label} data-testid={`volume-source-${definition.type}`}
              className="flex w-full items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!available || !!starting} onClick={() => { void selectSource(definition) }}>
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted"><definition.Logo className="h-7 w-7" /></div>
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">{definition.label}</p><p className="mt-1 text-sm text-muted-foreground">{available ? definition.description : definition.unavailableReason}</p></div>
              {starting === definition.type ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" /> : <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />}
            </button>
          })}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={!!starting}>Cancel</Button></DialogFooter>
      </>}
    </DialogContent>
  </Dialog>
}
