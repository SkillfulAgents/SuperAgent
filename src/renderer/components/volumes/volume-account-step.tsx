import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import type { useConnectedAccountsByToolkit } from '@renderer/hooks/use-connected-accounts'
import { useConnectAccount, type NewApiConnection } from '@renderer/hooks/use-connect-account'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { LoginButton } from '@renderer/components/connections/login-button'
import { LoginWindowCancel } from '@renderer/components/connections/login-window-cancel'
import { VolumeDetailsFields, VolumeSetupFooter } from './volume-setup-layout'
import type { VolumeDetails } from './volume-details-schema'

/** The account step of a remote source's setup: choose a connected account of its
 * toolkit, or connect one here, straight into the provider's sign-in. With no account
 * yet there is nothing to choose, so there is no list, just Connect; a first account
 * connected here moves straight on to the next step. A lone usable account is chosen
 * for you. */
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
  const list = accounts.data?.accounts ?? []
  const loaded = !accounts.isLoading && !accounts.error
  const hasAccounts = loaded && list.length > 0

  // A first account goes straight on once the refreshed list has it and it is usable.
  const [advanceTo, setAdvanceTo] = useState<string | null>(null)
  const firstAccount = useRef(false)
  const onConnected = useCallback(({ accountId: id, toolkit: connected }: NewApiConnection) => {
    if (connected !== toolkit) return
    onSelect(id)
    if (firstAccount.current) setAdvanceTo(id)
  }, [toolkit, onSelect])
  const { connect, connecting, canCancel, cancel, error } = useConnectAccount({ location: 'drive_setup', onConnected })
  const pending = connecting === toolkit

  useEffect(() => {
    if (!advanceTo || advanceTo !== accountId || !active) return
    setAdvanceTo(null)
    onNext()
  }, [advanceTo, accountId, active, onNext])

  const lone = loaded && list.length === 1 && list[0].status === 'active' ? list[0].id : null
  useEffect(() => {
    if (lone && !accountId) onSelect(lone)
  }, [lone, accountId, onSelect])

  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (active) onNext() }}>
    {accounts.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading {label} accounts…</p>}
    {accounts.error && <div><p role="alert" className="text-sm text-destructive">Could not load {label} accounts.</p><Button type="button" variant="ghost" size="sm" onClick={() => { void accounts.refetch() }}>Try again</Button></div>}
    {hasAccounts && <div className="space-y-2">
      <Label htmlFor={`volume-${toolkit}-account`}>{label} account</Label>
      <Select value={accountId} onValueChange={onSelect}>
        <SelectTrigger id={`volume-${toolkit}-account`}><SelectValue placeholder="Select an account" /></SelectTrigger>
        <SelectContent>
          {list.map(item => <SelectItem key={item.id} value={item.id} disabled={item.status !== 'active'}>
            {item.displayName}{item.status !== 'active' ? ' (reconnect in Connections)' : ''}
          </SelectItem>)}
        </SelectContent>
      </Select>
    </div>}
    <div className="space-y-1">
      <LoginButton type="button" variant={hasAccounts ? 'outline' : 'default'} className="w-full" icon={<Plus className="h-4 w-4" />}
        label={hasAccounts ? `Connect another ${label} account` : `Connect ${label}`} pendingLabel={`Connecting ${label}…`}
        pending={pending} canCancel={pending && canCancel} onCancel={cancel} cancelSide="none"
        disabled={accounts.isLoading || (connecting !== null && !pending)}
        onClick={() => { firstAccount.current = !hasAccounts; void connect(toolkit) }} data-testid={`volume-${toolkit}-connect`} />
      {/* The button is full width, so its Cancel sits under it. */}
      <div className="flex justify-center"><LoginWindowCancel visible={pending && canCancel} onCancel={cancel} testId={`volume-${toolkit}-connect-cancel`} /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={false} disabled={!active} submitLabel="Next" />
  </form>
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
      disabled={!active || !details.name.trim() || !canSave} submitLabel={attachToAgent ? 'Create and add' : 'Create drive'} />
  </form>
}
