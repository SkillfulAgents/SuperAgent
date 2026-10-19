import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useVolumeFolders } from '@renderer/hooks/use-volume-folders'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { cn } from '@shared/lib/utils/cn'
import { platformVolumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { VolumeDetailsFields, VolumeSetupFooter, VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

// The app icon carries its own light square, like Notion's service icon, so it reads on every tile.
function GamutLogo({ className }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" aria-hidden="true" className={cn('object-contain', className)} />
}

const NEW = 'new'

function PlatformVolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const drives = useVolumeFolders({ type: 'platform', label: 'Gamut drive' }, {}, true)
  const [driveId, setDriveId] = useState('')
  const [details, setDetails] = useState(initialDetails)
  // A save can fail after the drive was created; refresh so it can be picked.
  const refetchDrives = drives.refetch
  useEffect(() => { if (error) void refetchDrives() }, [error, refetchDrives])

  const selectDrive = (id: string) => {
    if (!id || id === driveId) return
    const previousName = drives.data?.folders.find(drive => drive.id === driveId)?.name
    setDriveId(id)
    const name = drives.data?.folders.find(drive => drive.id === id)?.name
    // A typed name stays; a name filled from the previous pick follows the new one (empty for a new drive).
    setDetails(current => !current.name || current.name === previousName ? { ...current, name: name ?? '' } : current)
    clearError()
  }

  const submit = () => {
    if (driveId) void onSubmit(driveId === NEW ? { name: details.name } : { volumeId: driveId }, details)
  }

  return <>
    <VolumeSetupHeader title="Set up Gamut drive" description="Choose a drive your org shares, or create one. Agents you add it to get read/write access."
      Logo={GamutLogo} steps={['Source', 'Details']} step={1} />
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); submit() }}>
      <div className="space-y-2">
        <Label htmlFor="volume-platform-drive">Drive</Label>
        <Select value={driveId} onValueChange={selectDrive} disabled={drives.isLoading || isSaving}>
          <SelectTrigger id="volume-platform-drive"><SelectValue placeholder={drives.isLoading ? 'Loading drives…' : 'Select a drive'} /></SelectTrigger>
          <SelectContent>
            {drives.data?.folders.map(drive => <SelectItem key={drive.id} value={drive.id}>{drive.name}</SelectItem>)}
            {!!drives.data?.folders.length && <SelectSeparator />}
            <SelectItem value={NEW}><span className="inline-flex items-center gap-2"><Plus className="h-4 w-4" />New drive</span></SelectItem>
          </SelectContent>
        </Select>
        {drives.error && <div><p role="alert" className="text-sm text-destructive">{drives.error.message}</p><Button type="button" variant="ghost" size="sm" onClick={() => { void drives.refetch() }}>Try again</Button></div>}
        {driveId === NEW && <p className="text-xs text-muted-foreground">Everyone in your org can add this drive to their agents.</p>}
      </div>
      {driveId && <VolumeDetailsFields value={details} onChange={value => { setDetails(value); clearError() }} disabled={isSaving}>{null}</VolumeDetailsFields>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={isSaving} disabled={!driveId || !details.name.trim()}
        submitLabel={driveId === NEW ? attachToAgent ? 'Create and add' : 'Create drive' : attachToAgent ? 'Add' : 'Add drive'} />
    </form>
  </>
}

export const platformVolumeSetup = {
  type: 'platform', label: 'Gamut drive', description: 'Shared with your org in Gamut.', Logo: GamutLogo,
  configSchema: platformVolumeConfigSchema, isAvailable: () => true, Setup: PlatformVolumeSetup,
} satisfies VolumeSetupDefinition<'platform'>
