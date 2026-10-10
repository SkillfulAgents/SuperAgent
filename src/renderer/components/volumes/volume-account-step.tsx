import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { useConnectedAccountsByToolkit } from '@renderer/hooks/use-connected-accounts'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { VolumeDetailsFields, VolumeSetupFooter } from './volume-setup-layout'
import type { VolumeDetails } from './volume-details-schema'

const IntegrationDirectoryDialog = lazy(async () => {
  const module = await import('@renderer/components/connections/integration-directory-dialog')
  return { default: module.IntegrationDirectoryDialog }
})

/** The account step of a remote source's setup: choose a connected account of its
 * toolkit, or connect one in the existing directory dialog. */
export function VolumeAccountStep({ toolkit, label, accounts, accountId, active, onSelect, onNext, onBack, onCancel }: {
  toolkit: string
  label: string
  accounts: ReturnType<typeof useConnectedAccountsByToolkit>
  accountId: string
  active: boolean
  onSelect: (id: string) => void
  onNext: () => void
  onBack: () => void
  onCancel: () => void
}) {
  const [connecting, setConnecting] = useState(false)
  return <>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (active) onNext() }}>
      <div className="space-y-2">
        <Label htmlFor={`volume-${toolkit}-account`}>{label} account</Label>
        <Select value={accountId} onValueChange={onSelect} disabled={accounts.isLoading}>
          <SelectTrigger id={`volume-${toolkit}-account`}><SelectValue placeholder={accounts.isLoading ? 'Loading accounts…' : 'Select an account'} /></SelectTrigger>
          <SelectContent>
            {accounts.data?.accounts.map(item => <SelectItem key={item.id} value={item.id} disabled={item.status !== 'active'}>
              {item.displayName}{item.status !== 'active' ? ' (reconnect in Connections)' : ''}
            </SelectItem>)}
          </SelectContent>
        </Select>
        {accounts.error && <div><p role="alert" className="text-sm text-destructive">Could not load {label} accounts.</p><Button type="button" variant="ghost" size="sm" onClick={() => { void accounts.refetch() }}>Try again</Button></div>}
        {!accounts.isLoading && !accounts.error && accounts.data?.accounts.length === 0 && <p className="text-sm text-muted-foreground">Connect your first {label} account to continue.</p>}
      </div>
      <Button type="button" variant="outline" className="w-full" onClick={() => setConnecting(true)}><Plus className="h-4 w-4" />Connect {label} account</Button>
      <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={false} disabled={!active} submitLabel="Next" />
    </form>
    {connecting && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading connections…</p>}><IntegrationDirectoryDialog open onOpenChange={setConnecting} initialTab="apis" initialFilter={label}
      onApiConnected={connection => { if (connection.toolkit === toolkit) onSelect(connection.accountId) }} /></Suspense>}
  </>
}

/** The details step of a remote source's setup: the chosen account, the name and access
 * fields around the source's folder picker, and the save footer. */
export function VolumeRemoteDetailsStep({ label, accountName, active, details, onDetailsChange, isSaving, error, canSave, attachToAgent, onSave, onBack, onCancel, children }: {
  label: string
  accountName: string | undefined
  active: boolean
  details: VolumeDetails
  onDetailsChange: (details: VolumeDetails) => void
  isSaving: boolean
  error: string | null
  canSave: boolean
  attachToAgent: boolean
  onSave: () => void
  onBack: () => void
  onCancel: () => void
  children: ReactNode
}) {
  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (active && canSave) onSave() }}>
    <p className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="selected-volume-account">{accountName ?? `${label} account`}</p>
    {!active && <p role="alert" className="text-sm text-destructive">This account is unavailable. Go back to choose or connect a {label} account.</p>}
    <VolumeDetailsFields value={details} onChange={onDetailsChange} disabled={isSaving}>{children}</VolumeDetailsFields>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={isSaving}
      disabled={!active || !details.name.trim() || !canSave} submitLabel={attachToAgent ? 'Create and attach' : 'Create volume'} />
  </form>
}
