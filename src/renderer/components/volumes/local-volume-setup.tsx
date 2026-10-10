import { useState } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { Button } from '@renderer/components/ui/button'
import { localVolumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { VolumeDetailsFields, VolumeSetupFooter, VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

async function selectLocalFolder() {
  if (!canUseHostFeatures()) throw new Error('Local folders are available in the desktop app on this workspace’s computer.')
  const path = await window.electronAPI?.openDirectory()
  return path ? localVolumeConfigSchema.parse({ path }) : null
}

function folderName(path: string) {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? 'Local folder'
}

function LocalVolumeSetup({ initialConfig, initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const [config, setConfig] = useState(() => localVolumeConfigSchema.parse(initialConfig))
  const [details, setDetails] = useState(() => ({ ...initialDetails, name: initialDetails.name || folderName(config.path) }))
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [isPicking, setIsPicking] = useState(false)

  const changeFolder = async () => {
    setPickerError(null)
    clearError()
    setIsPicking(true)
    try {
      const selected = await selectLocalFolder()
      if (selected) {
        setDetails(current => current.name === folderName(config.path) ? { ...current, name: folderName(selected.path) } : current)
        setConfig(selected)
      }
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : 'Could not open the folder picker')
    } finally { setIsPicking(false) }
  }

  return <>
    <VolumeSetupHeader title="Set up local volume" description="Choose a name for this folder. Attached agents get read/write access." Logo={Folder} steps={['Source', 'Details']} step={1} />
    <form onSubmit={event => { event.preventDefault(); void onSubmit(config, details) }} className="space-y-4">
      <VolumeDetailsFields value={details} onChange={value => { setDetails(value); clearError() }} disabled={isSaving || isPicking}>
        <div className="space-y-2">
          <p className="text-sm font-medium">Folder</p>
          <Button type="button" variant="outline" className="w-full justify-start" onClick={() => { void changeFolder() }} disabled={isSaving || isPicking}>
            <FolderOpen className="h-4 w-4" />Change folder
          </Button>
          <p className="break-all font-mono text-xs text-muted-foreground" data-testid="selected-volume-folder">{config.path}</p>
        </div>
      </VolumeDetailsFields>
      {(error || pickerError) && <p role="alert" className="text-sm text-destructive">{error || pickerError}</p>}
      <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={isSaving || isPicking} disabled={!details.name.trim() || !config.path} submitLabel={attachToAgent ? 'Create and attach' : 'Create volume'} />
    </form>
  </>
}

export const localVolumeSetup = {
  type: 'local', label: 'Local folder', description: 'Choose a folder on this computer.', Logo: Folder,
  configSchema: localVolumeConfigSchema, isAvailable: canUseHostFeatures,
  unavailableReason: 'Available in the desktop app for a local workspace.',
  begin: selectLocalFolder, Setup: LocalVolumeSetup,
} satisfies VolumeSetupDefinition<'local'>
