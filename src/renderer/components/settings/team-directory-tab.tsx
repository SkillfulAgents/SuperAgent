import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { PasswordInput } from '@renderer/components/ui/password-input'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  useConnectProvisioning, useConnectTeamDirectory, useDirectoryInstallStatus, useDisconnectProvisioning, useDisconnectTeamDirectory,
  useRefreshTeamDirectory, useStartDirectoryInstall, useTeamDirectories, useTestDirectoryCredentials,
} from '@renderer/hooks/use-team-directories'
import type {
  DirectoryProviderInfo, DirectoryProviderView, StartDirectoryInstallResponse, TeamDirectoryView,
} from '@shared/lib/team-directory/view-schema'
import { SetupPanel, SetupSteps } from './setup-steps'
import { useUser } from '@renderer/context/user-context'

const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

function StatusBadge({ directory }: { directory: TeamDirectoryView }) {
  if (directory.status === 'active') {
    return <span className="text-2xs px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">Connected</span>
  }
  return (
    <span className="inline-flex items-center gap-1 text-2xs px-1.5 py-0 rounded-full bg-red-500/10 text-red-700 dark:text-red-400">
      <AlertTriangle className="h-2.5 w-2.5" />
      Can’t read
    </span>
  )
}

function DirectoryRow({ directory, onDisconnect }: { directory: TeamDirectoryView; onDisconnect: () => void }) {
  const refresh = useRefreshTeamDirectory()
  const check = async () => {
    try {
      const result = await refresh.mutateAsync(directory.id)
      if (result.ok) toast.success(`Found ${result.userCount} ${result.userCount === 1 ? 'person' : 'people'} in ${directory.tenantName}`)
      else toast.error(result.error)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not check the directory')
    }
  }
  return (
    <IntegrationRow
      data-testid="team-directory-row"
      iconSlug={directory.provider}
      name={directory.tenantName}
      nameBadge={<StatusBadge directory={directory} />}
      subtitle={(
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">
            {directory.providerLabel}
            {directory.connectedBy ? ` · Connected by ${directory.connectedBy}` : ''}
            {` · ${new Date(directory.connectedAt).toLocaleDateString()}`}
          </span>
          {directory.status === 'error' && directory.errorMessage && (
            <span className="text-destructive" role="status">{directory.errorMessage}</span>
          )}
        </span>
      )}
      right={(
        <>
          <Button variant="ghost" size="sm" onClick={() => void check()} disabled={refresh.isPending} aria-label={`Check ${directory.tenantName}`}>
            {refresh.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check
          </Button>
          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" aria-label={`Disconnect ${directory.tenantName}`} title="Disconnect" onClick={onDisconnect}>
            <X className="h-4 w-4" />
          </Button>
        </>
      )}
    />
  )
}

const STEP_HEADING = 'text-xs font-medium uppercase tracking-wide text-muted-foreground'

function StepLink({ step, index, link }: { step: string; index: number; link?: DirectoryProviderInfo['setupLink'] }) {
  return (
    <>
      <span>{step}</span>
      {index === 0 && link && (
        <a href={link.href} target="_blank" rel="noreferrer" className="mt-1 inline-flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline">
          {link.label}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </>
  )
}

/** A provider's instructions: one line with its link when that is all there is, numbered steps otherwise. */
function Steps({ steps, link }: { steps: string[]; link?: DirectoryProviderInfo['setupLink'] }) {
  if (steps.length === 1) {
    return (
      <p>
        {steps[0]}{' '}
        {link && (
          <a href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-primary hover:underline">
            {link.label}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </p>
    )
  }
  return <SetupSteps steps={steps.map((step, index) => <StepLink key={index} step={step} index={index} link={link} />)} />
}

/**
 * Connecting with the provider's app-creation credentials alone: paste them,
 * Gamut creates the directory's app, then one click installs it on the
 * provider's page. Drawn from what the provider describes, like the rest.
 */
function AppConnectForm({ provider, onManual }: { provider: DirectoryProviderView; onManual: () => void }) {
  const info = provider.provisioning!
  const client = useQueryClient()
  const start = useStartDirectoryInstall()
  const login = useLoginWindow()
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [install, setInstall] = useState<StartDirectoryInstallResponse | null>(null)
  const [polling, setPolling] = useState(false)
  const [seenCancel, setSeenCancel] = useState<number | null>(null)
  const status = useDirectoryInstallStatus(install?.installId ?? null, polling)
  const complete = info.fields.every((field) => values[field.key]?.trim())
  const outcome = status.data

  const closeLogin = login.close
  const startOver = useCallback((message: string | null) => {
    closeLogin()
    setPolling(false)
    setInstall(null)
    setError(message)
  }, [closeLogin])

  useEffect(() => {
    if (!outcome || !install) return
    if (outcome.status === 'connected') {
      startOver(null)
      setValues({})
      toast.success(`Connected ${outcome.tenantName}`, outcome.notices.length ? { description: outcome.notices.join(' ') } : undefined)
      void client.invalidateQueries({ queryKey: ['team-directories'] })
    } else if (outcome.status === 'failed') {
      startOver(outcome.error)
    } else if (outcome.status === 'expired') {
      startOver('The install took too long. Generate a new token and start again.')
    } else if (outcome.status === 'cancelled' && outcome.at !== seenCancel) {
      setSeenCancel(outcome.at)
      setPolling(false)
      closeLogin()
    }
  }, [outcome, install, seenCancel, startOver, client, closeLogin])

  const create = async () => {
    setError(null)
    try {
      setInstall(await start.mutateAsync({ provider: provider.id, credentials: values }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the app')
    }
  }
  const openInstall = () => {
    if (!install) return
    setPolling(true)
    void login.open(async () => install.url).catch((err: unknown) => {
      setPolling(false)
      setError(err instanceof Error ? err.message : 'Could not open the install page')
    })
  }
  const cancelled = outcome?.status === 'cancelled' && outcome.at === seenCancel

  if (install) {
    return (
      <SetupPanel data-testid={`team-directory-install-${provider.id}`}>
        <p className={STEP_HEADING}>Step 2 of 2 · Install</p>
        <p>Gamut created its {provider.label} app in your workspace. Install it to finish connecting.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={openInstall} disabled={polling && login.waiting} data-testid="team-directory-install-button">
            {polling && login.pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Install on {provider.label}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => startOver(null)}>Start over</Button>
        </div>
        {polling && login.waiting && (
          <p role="status" className="text-xs text-muted-foreground">Approve the install in the window that opened. This page updates when it’s done.</p>
        )}
        {cancelled && !polling && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">The install was cancelled. Install again when you’re ready.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </SetupPanel>
    )
  }

  return (
    <SetupPanel data-testid={`team-directory-connect-${provider.id}`}>
      <p className={STEP_HEADING}>Step 1 of 2 · Add a token</p>
      <Steps steps={info.steps} link={info.setupLink} />
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (complete && !start.isPending) void create() }}>
        <CredentialFields idPrefix={`team-directory-${provider.id}-app`} fields={info.fields} values={values}
          onChange={(key, value) => { setValues((previous) => ({ ...previous, [key]: value })); setError(null) }} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" size="sm" disabled={!complete || start.isPending}>
          {start.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Continue
        </Button>
      </form>
      <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onManual}>
        Use a {provider.label} app you already have
      </button>
    </SetupPanel>
  )
}

/** A provider's way in: its app-creation credentials when they can connect it, else (or on request) its own form. */
function ConnectSection({ provider }: { provider: DirectoryProviderView }) {
  const [manual, setManual] = useState(false)
  if (provider.provisioning?.connectsDirectory && !manual) return <AppConnectForm provider={provider} onManual={() => setManual(true)} />
  return <ConnectForm provider={provider} onBack={provider.provisioning?.connectsDirectory ? () => setManual(false) : undefined} />
}

/** The connect form, drawn from what the provider says it needs. */
function ConnectForm({ provider, onBack }: { provider: DirectoryProviderInfo; onBack?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState<{ tenantName: string; notices: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const test = useTestDirectoryCredentials()
  const connect = useConnectTeamDirectory()
  const input = { provider: provider.id, credentials: values }
  const complete = provider.fields.every((field) => values[field.key]?.trim())
  const busy = test.isPending || connect.isPending

  const update = (key: string, value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }))
    setChecked(null)
    setError(null)
  }
  const runTest = async () => {
    setError(null)
    try {
      const result = await test.mutateAsync(input)
      setChecked({ tenantName: result.tenantName, notices: result.notices ?? [] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check these credentials')
    }
  }
  const runConnect = async () => {
    setError(null)
    try {
      const { directory, notices } = await connect.mutateAsync(input)
      toast.success(`Connected ${directory.tenantName}`, notices?.length ? { description: notices.join(' ') } : undefined)
      setValues({})
      setChecked(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect the directory')
    }
  }

  return (
    <SetupPanel data-testid={`team-directory-connect-${provider.id}`}>
      <p className="text-muted-foreground">{provider.description}</p>
      <Steps steps={provider.steps} link={provider.setupLink} />
      <form
        className="space-y-3"
        onSubmit={(event) => { event.preventDefault(); if (complete && !busy) void runConnect() }}
      >
        {provider.fields.map((field) => {
          const id = `team-directory-${provider.id}-${field.key}`
          const props = {
            id,
            value: values[field.key] ?? '',
            placeholder: field.placeholder,
            autoComplete: 'off',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => update(field.key, event.target.value),
            className: 'bg-background font-mono text-xs',
          }
          return (
            <div key={field.key} className="grid gap-1.5">
              <Label htmlFor={id} className="text-xs">{field.label}</Label>
              {field.secret ? <PasswordInput {...props} /> : <Input {...props} />}
            </div>
          )
        })}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {checked && !error && (
          <div role="status" className="space-y-1 text-xs">
            <p className="inline-flex items-center gap-1.5 text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Works with {checked.tenantName}
            </p>
            {checked.notices.map((notice) => (
              <p key={notice} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                {notice}
              </p>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!complete || busy} onClick={() => void runTest()}>
            {test.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Test
          </Button>
          <Button type="submit" size="sm" disabled={!complete || busy}>
            {connect.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Connect {provider.label}
          </Button>
        </div>
      </form>
      {onBack && (
        <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={onBack}>
          Let Gamut create the app instead
        </button>
      )}
    </SetupPanel>
  )
}

/** The fields of a credentials form, drawn from what a provider describes. */
function CredentialFields({ idPrefix, fields, values, onChange }: {
  idPrefix: string
  fields: DirectoryProviderInfo['fields']
  values: Record<string, string>
  onChange: (key: string, value: string) => void
}) {
  return <>{fields.map((field) => {
    const id = `${idPrefix}-${field.key}`
    const props = {
      id,
      value: values[field.key] ?? '',
      placeholder: field.placeholder,
      autoComplete: 'off',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(field.key, event.target.value),
      className: 'bg-background font-mono text-xs',
    }
    return (
      <div key={field.key} className="grid gap-1.5">
        <Label htmlFor={id} className="text-xs">{field.label}</Label>
        {field.secret ? <PasswordInput {...props} /> : <Input {...props} />}
      </div>
    )
  })}</>
}

function ProvisioningBadge({ status }: { status: 'active' | 'needs_reconnect' | null }) {
  if (status === 'active') return <span className="text-2xs px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">Creating apps</span>
  if (status === 'needs_reconnect') {
    return <span className="inline-flex items-center gap-1 text-2xs px-1.5 py-0 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-2.5 w-2.5" />Needs a new token</span>
  }
  return <span className="text-2xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground">Not set up</span>
}

/**
 * Creating agents' own apps through a connected directory: its credentials,
 * drawn from what the provider describes, and whether they still renew.
 */
function ProvisioningPanel({ directory, provider }: { directory: TeamDirectoryView; provider: DirectoryProviderView }) {
  const info = provider.provisioning
  const { data: relay } = useWebhookRelay()
  const connect = useConnectProvisioning()
  const disconnect = useDisconnectProvisioning()
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const status = directory.provisioning?.status ?? null
  const [editing, setEditing] = useState(status !== 'active')
  if (!info) return null
  const complete = info.fields.every((field) => values[field.key]?.trim())

  const save = async () => {
    setError(null)
    try {
      await connect.mutateAsync({ id: directory.id, credentials: values })
      setValues({})
      setEditing(false)
      toast.success(`${directory.tenantName} can create agents’ apps now`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the credentials')
    }
  }
  const stop = async () => {
    try {
      await disconnect.mutateAsync(directory.id)
      setEditing(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not stop creating apps')
    }
  }

  return (
    <SetupPanel data-testid={`team-directory-provisioning-${directory.id}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{directory.tenantName}</span>
        <ProvisioningBadge status={status} />
      </div>
      <p className="text-muted-foreground">{info.description}</p>
      {status === 'needs_reconnect' && directory.provisioning?.error && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{directory.provisioning.error} Apps already installed keep working.</p>
      )}
      {status === 'active' && relay && !relay.available && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400" data-testid="provisioning-needs-relay">
          Agents’ apps receive through this host’s webhook relay, which comes with a Gamut Platform connection. Until it’s connected, agents are set up by hand.
        </p>
      )}
      {status === 'active' && !editing ? (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>Replace token</Button>
          <Button type="button" variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => void stop()}>Stop creating apps</Button>
        </div>
      ) : (
        <>
          <Steps steps={info.steps} link={info.setupLink} />
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (complete && !connect.isPending) void save() }}>
            <CredentialFields idPrefix={`provisioning-${directory.id}`} fields={info.fields} values={values}
              onChange={(key, value) => { setValues((previous) => ({ ...previous, [key]: value })); setError(null) }} />
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!complete || connect.isPending}>
                {connect.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
              {status === 'active' && <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setValues({}) }}>Cancel</Button>}
            </div>
          </form>
        </>
      )}
    </SetupPanel>
  )
}

export function TeamDirectoryTab() {
  const { isAuthMode } = useUser()
  const { data, isLoading, error } = useTeamDirectories()
  const disconnect = useDisconnectTeamDirectory()
  const [disconnecting, setDisconnecting] = useState<TeamDirectoryView | null>(null)
  const [providerId, setProviderId] = useState<string | null>(null)
  const providers = data?.providers ?? []
  const directories = data?.directories ?? []
  const provider = providers.find((p) => p.id === providerId) ?? providers[0]

  const confirmDisconnect = async () => {
    if (!disconnecting) return
    try {
      await disconnect.mutateAsync(disconnecting.id)
      setDisconnecting(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect the directory')
    }
  }

  return (
    <div className="space-y-6" data-testid="team-directory-settings">
      <p className="text-sm text-muted-foreground">
        {isAuthMode
          ? 'Connect your team’s directory, and the people in it who aren’t on Gamut yet show up when someone shares an agent or mentions a teammate. Their access is ready when they join. It can also give each agent its own app in one click.'
          : 'Connect your team’s directory to give each agent its own app (its name, @handle and avatar) in one click.'}
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : 'Could not load team directories'}</p>}
      {isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <section className="space-y-2">
            <h3 className={SECTION_HEADING}>Connected</h3>
            {directories.length === 0 ? (
              <div className="rounded-card border border-dashed p-6 text-center">
                <Users className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No directory connected yet.</p>
              </div>
            ) : (
              <IntegrationList>
                {directories.map((directory) => (
                  <DirectoryRow key={directory.id} directory={directory} onDisconnect={() => setDisconnecting(directory)} />
                ))}
              </IntegrationList>
            )}
          </section>
          {directories.some((d) => d.provisioning) && (
            <section className="space-y-2">
              <h3 className={SECTION_HEADING}>Agent apps</h3>
              {directories.filter((d) => d.provisioning).map((directory) => {
                const directoryProvider = providers.find((p) => p.id === directory.provider)
                return directoryProvider ? <ProvisioningPanel key={directory.id} directory={directory} provider={directoryProvider} /> : null
              })}
            </section>
          )}
          {provider && (
            <section className="space-y-2">
              <h3 className={SECTION_HEADING}>Connect a directory</h3>
              {providers.length > 1 && (
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Directory provider">
                  {providers.map((p) => (
                    <Button key={p.id} type="button" size="sm" variant={p.id === provider.id ? 'default' : 'outline'} role="radio" aria-checked={p.id === provider.id} onClick={() => setProviderId(p.id)}>
                      {p.label}
                    </Button>
                  ))}
                </div>
              )}
              <ConnectSection key={provider.id} provider={provider} />
            </section>
          )}
        </>
      )}
      <AlertDialog open={disconnecting !== null} onOpenChange={(open) => { if (!open) setDisconnecting(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {disconnecting?.tenantName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its people stop appearing when sharing agents or mentioning teammates. People already invited keep their access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending}
              onClick={(event) => { event.preventDefault(); void confirmDisconnect() }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
