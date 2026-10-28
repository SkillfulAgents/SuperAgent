import { useState } from 'react'
import { useConnectedAccountsByToolkit } from '@renderer/hooks/use-connected-accounts'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { dropboxVolumeConfigSchema, type DropboxVolumeConfig } from '@shared/lib/volumes/dropbox-schema'
import { VolumeAccountStep, VolumeRemoteDetailsStep } from './volume-account-step'
import { VolumeFolderPicker, type VolumeFolderSource } from './volume-folder-picker'
import { VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

function DropboxLogo({ className }: { className?: string }) {
  return <ServiceIcon slug="dropbox" className={className} />
}

/** The picker walks Dropbox paths from the account root (''), which can be chosen too, for the whole Dropbox. */
const dropboxFolders: VolumeFolderSource<string> = {
  type: 'dropbox', label: 'Dropbox',
  title: 'Choose a Dropbox folder', description: 'Select the folder to use, or open one to look inside it.',
  query: (accountId, path) => ({ accountId, path }),
  folders: data => data.folders.map(folder => ({ id: folder.id, name: folder.name, cursor: folder.id })),
  crumbs: path => {
    const names = path.split('/').filter(Boolean)
    return [{ name: 'Dropbox', cursor: '' }, ...names.map((name, index) => ({ name, cursor: `/${names.slice(0, index + 1).join('/')}` }))]
  },
  confirmLabel: path => path ? `Use “${path.split('/').at(-1)}”` : 'Use all of Dropbox',
}

function DropboxVolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const accounts = useConnectedAccountsByToolkit('dropbox')
  const [step, setStep] = useState<'account' | 'details'>('account')
  const [accountId, setAccountId] = useState('')
  const [config, setConfig] = useState<DropboxVolumeConfig | null>(null)
  const [details, setDetails] = useState(initialDetails)
  const account = accounts.data?.accounts.find(item => item.id === accountId)
  const active = account?.status === 'active' && !accounts.error

  const selectAccount = (id: string) => {
    if (id === accountId) return
    if (config && details.name === (config.path.split('/').at(-1) || 'Dropbox')) setDetails({ ...details, name: '' })
    setAccountId(id)
    setConfig(null)
    clearError()
  }

  return <>
    <VolumeSetupHeader title={step === 'account' ? 'Connect Dropbox' : 'Set up Dropbox drive'}
      description={step === 'account' ? (accounts.data?.accounts.length === 0 ? 'Sign in to Dropbox, then choose a folder to add.' : 'Choose an account or connect a new one.') : 'Select a folder and name it. Agents you add it to get read/write access.'}
      Logo={DropboxLogo} steps={['Source', 'Account', 'Details']} step={step === 'account' ? 1 : 2} />
    {step === 'account' ? <VolumeAccountStep toolkit="dropbox" label="Dropbox" accounts={accounts} accountId={accountId} active={active}
      onSelect={selectAccount} onNext={() => { clearError(); setStep('details') }} onBack={onBack} onCancel={onCancel} />
    : <VolumeRemoteDetailsStep label="Dropbox" accountName={account?.displayName} active={active} details={details}
      onDetailsChange={value => { setDetails(value); clearError() }} isSaving={isSaving} error={error} canSave={!!config} attachToAgent={attachToAgent}
      onSave={() => { if (config) void onSubmit(config, details) }} onBack={() => { clearError(); setStep('account') }} onCancel={onCancel}>
      <VolumeFolderPicker key={accountId} source={dropboxFolders} accountId={accountId} initial={config?.path ?? ''}
          selected={config ? config.path || 'Entire Dropbox' : null} disabled={isSaving || !active} onChange={path => {
            const previousName = config?.path.split('/').at(-1) || 'Dropbox'
            setConfig({ accountId, path })
            setDetails(current => !current.name || current.name === previousName ? { ...current, name: path.split('/').at(-1) || 'Dropbox' } : current)
            clearError()
          }} />
    </VolumeRemoteDetailsStep>}
  </>
}

export const dropboxVolumeSetup = {
  type: 'dropbox', label: 'Dropbox', description: 'Connect an account and choose a folder.', Logo: DropboxLogo,
  configSchema: dropboxVolumeConfigSchema, isAvailable: () => true, Setup: DropboxVolumeSetup,
} satisfies VolumeSetupDefinition<'dropbox'>
