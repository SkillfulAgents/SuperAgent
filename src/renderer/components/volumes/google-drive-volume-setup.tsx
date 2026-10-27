import { useState } from 'react'
import { useConnectedAccountsByToolkit } from '@renderer/hooks/use-connected-accounts'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { googleDriveVolumeConfigSchema, type GoogleDriveVolumeConfig } from '@shared/lib/volumes/google-drive-schema'
import { VolumeAccountStep, VolumeRemoteDetailsStep } from './volume-account-step'
import { VolumeFolderPicker, type VolumeFolderSource } from './volume-folder-picker'
import { VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

function GoogleDriveLogo({ className }: { className?: string }) {
  return <ServiceIcon slug="googledrive" className={className} />
}

/** The picker walks folder IDs from the top, where My Drive and each shared drive sit, and opens in My Drive. Any folder or drive
 * can be chosen; the top itself can't. */
type DriveCursor = { id: string; name: string }[]
const googleDriveFolders: VolumeFolderSource<DriveCursor> = {
  type: 'googledrive', label: 'Google Drive',
  title: 'Choose a Google Drive folder', description: 'Select the folder to use, or open one to look inside it. Shared drives are under Google Drive.',
  query: (accountId, cursor): Record<string, string> => { const current = cursor.at(-1); return current ? { accountId, folderId: current.id } : { accountId } },
  folders: (data, cursor) => data.folders.map(folder => ({ id: folder.id, name: folder.name, cursor: [...cursor, folder] })),
  crumbs: cursor => [{ name: 'Google Drive', cursor: [] }, ...cursor.map((folder, index) => ({ name: folder.name, cursor: cursor.slice(0, index + 1) }))],
  confirmLabel: cursor => { const current = cursor.at(-1); return current ? `Use “${current.name}”` : null },
  opensInFirst: true,
}

/** Where a chosen folder is, from its drive down: "My Drive / Projects / Team". */
const drivePath = (cursor: DriveCursor) => cursor.map(folder => folder.name).join(' / ')

function GoogleDriveVolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const accounts = useConnectedAccountsByToolkit('googledrive')
  const [step, setStep] = useState<'account' | 'details'>('account')
  const [accountId, setAccountId] = useState('')
  const [config, setConfig] = useState<GoogleDriveVolumeConfig | null>(null)
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [details, setDetails] = useState(initialDetails)
  const account = accounts.data?.accounts.find(item => item.id === accountId)
  const active = account?.status === 'active' && !accounts.error

  const selectAccount = (id: string) => {
    if (id === accountId) return
    if (config && details.name === config.folderName) setDetails({ ...details, name: '' })
    setAccountId(id)
    setConfig(null)
    setFolderPath(null)
    clearError()
  }

  return <>
    <VolumeSetupHeader title={step === 'account' ? 'Connect Google Drive' : 'Set up Google Drive'}
      description={step === 'account' ? (accounts.data?.accounts.length === 0 ? 'Sign in to Google Drive, then choose a folder to add.' : 'Choose an account or connect a new one.') : 'Select a folder and name it. Agents you add it to get read/write access.'}
      Logo={GoogleDriveLogo} steps={['Source', 'Account', 'Details']} step={step === 'account' ? 1 : 2} />
    {step === 'account' ? <VolumeAccountStep toolkit="googledrive" label="Google Drive" accounts={accounts} accountId={accountId} active={active}
      onSelect={selectAccount} onNext={() => { clearError(); setStep('details') }} onBack={onBack} onCancel={onCancel} />
    : <VolumeRemoteDetailsStep label="Google Drive" accountName={account?.displayName} active={active} details={details}
      onDetailsChange={value => { setDetails(value); clearError() }} isSaving={isSaving} error={error} canSave={!!config} attachToAgent={attachToAgent}
      onSave={() => { if (config) void onSubmit(config, details) }} onBack={() => { clearError(); setStep('account') }} onCancel={onCancel}>
      <VolumeFolderPicker key={accountId} source={googleDriveFolders} accountId={accountId} initial={[]}
          selected={config ? folderPath : null} disabled={isSaving || !active} onChange={cursor => {
            const folder = cursor.at(-1)
            if (!folder) return
            const previousName = config?.folderName
            setConfig({ accountId, folderId: folder.id, folderName: folder.name, driveName: cursor[0].name })
            setFolderPath(drivePath(cursor))
            setDetails(current => !current.name || current.name === previousName ? { ...current, name: folder.name } : current)
            clearError()
          }} />
      <p className="text-xs text-muted-foreground">Google Docs, Sheets and Slides appear as .md, .xlsx and .pptx files. Saving one updates the Google file. A saved Doc keeps its text but not its colors, fonts, alignment, tabs or pending suggestions.</p>
    </VolumeRemoteDetailsStep>}
  </>
}

export const googleDriveVolumeSetup = {
  type: 'googledrive', label: 'Google Drive', description: 'Connect an account and choose a folder, My Drive or a shared drive.', Logo: GoogleDriveLogo,
  configSchema: googleDriveVolumeConfigSchema, isAvailable: () => true, Setup: GoogleDriveVolumeSetup,
} satisfies VolumeSetupDefinition<'googledrive'>
