import { useState } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { storedPlatformVolumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { VolumeFolderPicker, type VolumeFolderSource } from './volume-folder-picker'
import { VolumeDetailsFields, VolumeSetupFooter, VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

// The app icon carries its own light square, like Notion's service icon, so it reads on every tile.
function GamutLogo({ className }: { className?: string }) {
  return <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" aria-hidden="true" className={cn('object-contain', className)} />
}

/** The picker lists the org's drives at one level. A drive is chosen whole, so none is opened; a new one is made at that level. */
type DriveCursor = { id: string; name: string } | null
const gamutDrives: VolumeFolderSource<DriveCursor> = {
  type: 'platform', label: 'Gamut drive', noun: 'drive', fieldLabel: 'Drive',
  title: 'Choose a Gamut drive', description: 'Select a drive your org shares, or make a new one.',
  query: () => ({}),
  folders: data => data.folders.map(drive => ({ id: drive.id, name: drive.name, cursor: drive })),
  crumbs: () => [{ name: 'Gamut drives', cursor: null }],
  confirmLabel: cursor => cursor ? `Use “${cursor.name}”` : null,
  canOpen: () => false,
  canCreate: cursor => cursor === null,
}

function PlatformVolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const [drive, setDrive] = useState<DriveCursor>(null)
  const [details, setDetails] = useState(initialDetails)

  return <>
    <VolumeSetupHeader title="Set up Gamut drive" description="Choose a drive your org shares, or make one. Agents you add it to get read/write access."
      Logo={GamutLogo} steps={['Source', 'Details']} step={1} />
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (drive) void onSubmit({ volumeId: drive.id }, details) }}>
      <VolumeFolderPicker source={gamutDrives} accountId="" initial={null} selected={drive?.name ?? null} disabled={isSaving} onChange={picked => {
        if (!picked) return
        // A typed name stays; a name filled from the previous pick follows the new one.
        setDetails(current => !current.name || current.name === drive?.name ? { ...current, name: picked.name } : current)
        setDrive(picked)
        clearError()
      }} />
      {drive && <VolumeDetailsFields value={details} onChange={value => { setDetails(value); clearError() }} disabled={isSaving}>{null}</VolumeDetailsFields>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={isSaving} disabled={!drive || !details.name.trim()}
        submitLabel={attachToAgent ? 'Add' : 'Add drive'} />
    </form>
  </>
}

export const platformVolumeSetup = {
  type: 'platform', label: 'Gamut drive', description: 'Shared with your org in Gamut.', Logo: GamutLogo,
  configSchema: storedPlatformVolumeConfigSchema, isAvailable: () => true, Setup: PlatformVolumeSetup,
} satisfies VolumeSetupDefinition<'platform'>
