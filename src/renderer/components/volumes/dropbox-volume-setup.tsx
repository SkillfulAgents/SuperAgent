import { lazy, Suspense, useState } from 'react'
import { Plus } from 'lucide-react'
import { useConnectedAccountsByToolkit } from '@renderer/hooks/use-connected-accounts'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { dropboxVolumeConfigSchema, type DropboxVolumeConfig } from '@shared/lib/volumes/dropbox-schema'
import { DropboxFolderPicker } from './dropbox-folder-picker'
import { VolumeDetailsFields, VolumeSetupFooter, VolumeSetupHeader } from './volume-setup-layout'
import type { VolumeSetupDefinition, VolumeSetupProps } from './volume-setup'

const IntegrationDirectoryDialog = lazy(async () => {
  const module = await import('@renderer/components/connections/integration-directory-dialog')
  return { default: module.IntegrationDirectoryDialog }
})

function DropboxLogo({ className }: { className?: string }) {
  return <ServiceIcon slug="dropbox" className={className} />
}

function DropboxVolumeSetup({ initialDetails, onSubmit, onBack, onCancel, isSaving, error, clearError, attachToAgent }: VolumeSetupProps) {
  const accounts = useConnectedAccountsByToolkit('dropbox')
  const [step, setStep] = useState<'account' | 'details'>('account')
  const [accountId, setAccountId] = useState('')
  const [config, setConfig] = useState<DropboxVolumeConfig | null>(null)
  const [details, setDetails] = useState(initialDetails)
  const [connecting, setConnecting] = useState(false)
  const account = accounts.data?.accounts.find(item => item.id === accountId)
  const active = account?.status === 'active' && !accounts.error

  const selectAccount = (id: string) => {
    // Radix's hidden select can emit an empty value while OAuth refreshes the list.
    if (!id || id === accountId) return
    if (config && details.name === (config.path.split('/').at(-1) || 'Dropbox')) setDetails({ ...details, name: '' })
    setAccountId(id)
    setConfig(null)
    clearError()
  }

  return <>
    <VolumeSetupHeader title={step === 'account' ? 'Connect Dropbox' : 'Set up Dropbox volume'}
      description={step === 'account' ? 'Choose an account or connect a new one.' : 'Select a folder and name it. Attached agents get read/write access.'}
      Logo={DropboxLogo} steps={['Source', 'Account', 'Details']} step={step === 'account' ? 1 : 2} />
    {step === 'account' ? <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (active) { clearError(); setStep('details') } }}>
      <div className="space-y-2">
        <Label htmlFor="volume-dropbox-account">Dropbox account</Label>
        <Select value={accountId} onValueChange={selectAccount} disabled={accounts.isLoading}>
          <SelectTrigger id="volume-dropbox-account"><SelectValue placeholder={accounts.isLoading ? 'Loading accounts…' : 'Select an account'} /></SelectTrigger>
          <SelectContent>
            {accounts.data?.accounts.map(item => <SelectItem key={item.id} value={item.id} disabled={item.status !== 'active'}>
              {item.displayName}{item.status !== 'active' ? ' (reconnect in Connections)' : ''}
            </SelectItem>)}
          </SelectContent>
        </Select>
        {accounts.error && <div><p role="alert" className="text-sm text-destructive">Could not load Dropbox accounts.</p><Button type="button" variant="ghost" size="sm" onClick={() => { void accounts.refetch() }}>Try again</Button></div>}
        {!accounts.isLoading && !accounts.error && accounts.data?.accounts.length === 0 && <p className="text-sm text-muted-foreground">Connect your first Dropbox account to continue.</p>}
      </div>
      <Button type="button" variant="outline" className="w-full" onClick={() => setConnecting(true)}><Plus className="h-4 w-4" />Connect Dropbox account</Button>
      <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={false} disabled={!active} submitLabel="Next" />
    </form> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (active && config) void onSubmit(config, details) }}>
      <p className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="selected-volume-account">{account?.displayName ?? 'Dropbox account'}</p>
      {!active && <p role="alert" className="text-sm text-destructive">This account is unavailable. Go back to choose or connect a Dropbox account.</p>}
      <VolumeDetailsFields value={details} onChange={value => { setDetails(value); clearError() }} disabled={isSaving}>
        <DropboxFolderPicker key={accountId} accountId={accountId} value={config} disabled={isSaving || !active} onChange={selected => {
          const previousName = config?.path.split('/').at(-1) || 'Dropbox'
          setConfig(selected)
          setDetails(current => !current.name || current.name === previousName ? { ...current, name: selected.path.split('/').at(-1) || 'Dropbox' } : current)
          clearError()
        }} />
      </VolumeDetailsFields>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <VolumeSetupFooter onBack={() => { clearError(); setStep('account') }} onCancel={onCancel} isSaving={isSaving}
        disabled={!active || !details.name.trim() || !config} submitLabel={attachToAgent ? 'Create and attach' : 'Create volume'} />
    </form>}
    {connecting && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading connections…</p>}><IntegrationDirectoryDialog open onOpenChange={setConnecting} initialTab="apis" initialFilter="Dropbox"
      onApiConnected={connection => { if (connection.toolkit === 'dropbox') selectAccount(connection.accountId) }} /></Suspense>}
  </>
}

export const dropboxVolumeSetup = {
  type: 'dropbox', label: 'Dropbox', description: 'Connect an account and choose a folder.', Logo: DropboxLogo,
  configSchema: dropboxVolumeConfigSchema, isAvailable: () => true, Setup: DropboxVolumeSetup,
} satisfies VolumeSetupDefinition<'dropbox'>
