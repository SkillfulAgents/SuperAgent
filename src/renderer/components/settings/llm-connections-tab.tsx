import { ProviderUsage } from './provider-usage'
import { ProviderLogo } from './provider-logo'
import { SubscriptionSignIn } from './subscription-sign-in'
import { CopyableValue, SetupPanel, SetupSteps } from './setup-steps'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import { withGlobalModelPricing } from '@shared/lib/llm-provider/global-pricing'
import type { GlobalModelPricing } from '@shared/lib/llm-provider/global-pricing-schema'
import { useCallback, useId, useState, type ReactNode } from 'react'
import { ChevronDown, MoreHorizontal, Plus, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useUser } from '@renderer/context/user-context'
import { useModelSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useLlmConnections, useConnectionMutation } from '@renderer/hooks/use-llm-connections'
import { ModelPickerPopover, SettingsModelSelect } from './settings-model-select'
import { CatalogEditor } from './model-catalog/catalog-editor'
import { mergeCatalog } from '@shared/lib/llm-provider/catalog-merge'
import type { CatalogOverrideEntry } from '@shared/lib/llm-provider/model-catalog-schema'
import type {
  ConnectionInfo,
  ConnectionConfig,
  ModelSelection,
} from '@shared/lib/llm-provider/connection-schema'
import type { LlmProviderId } from '@shared/lib/llm-provider/provider-types'

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
// Shared by connection rows and the Add connection row so the list keeps one row height.
const CONNECTION_ROW = 'min-h-[3.75rem] py-3 px-4 flex items-center'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'
// Radix Select items can't use '' as a value, so "Everyone" (a global connection, owner null) gets a sentinel.
const EVERYONE = 'everyone'
const providers = {
  anthropic: 'Anthropic API',
  'claude-subscription': 'Claude Subscription',
  'grok-subscription': 'Grok Subscription',
  'codex-subscription': 'Codex Subscription',
  openrouter: 'OpenRouter',
  bedrock: 'AWS Bedrock',
  generic: 'Generic',
}
// Example names for the connection-name placeholder.
const nameExamples: Record<keyof typeof providers, string> = {
  anthropic: 'Team API key',
  'claude-subscription': 'Personal Claude Max',
  'grok-subscription': 'Personal Grok',
  'codex-subscription': 'Work ChatGPT Pro',
  openrouter: 'Shared OpenRouter',
  bedrock: 'Bedrock us-east-1',
  generic: 'Local vLLM server',
}
// Shown on the provider cards that open the Add connection flow.
const providerDescriptions: Record<keyof typeof providers, string> = {
  anthropic: 'Direct API access to Claude models with an API key.',
  'claude-subscription': 'Use your Claude Pro or Max plan through a Claude Code setup token.',
  'grok-subscription': 'Sign in with your xAI account to use your Grok subscription.',
  'codex-subscription': 'Sign in with ChatGPT to use your Codex subscription.',
  openrouter: 'Multi-model access through a single API key.',
  bedrock: 'AWS managed Claude inference with IAM or API key credentials.',
  generic: 'Any Anthropic- or OpenAI-compatible endpoint at a base URL.',
}
export function LlmConnectionsTab() {
  const { data, isLoading, error } = useLlmConnections()
  const { data: settings } = useModelSettings()
  const updateSettings = useUpdateSettings()
  const { user, isAdmin, isAuthMode } = useUser()
  const mutation = useConnectionMutation()
  // 'pick' shows the provider cards; picking one opens the editor for a new connection with that provider.
  const [editing, setEditing] = useState<ConnectionInfo | 'pick' | { provider: LlmProviderId } | null>(null)
  const defaultRequiresSummarizer = data?.connections.find(c => c.id === data.defaultSelection?.llmProviderId)?.supportsDirectApi === false
  const summarizerSelection = data?.summarizerSelection ?? (defaultRequiresSummarizer ? null : data?.defaultSelection)
  const changeDefault = (purpose: string, selection: ModelSelection | null) =>
    mutation.mutate(
      { path: `/defaults/${purpose}`, method: 'PUT', body: selection },
      { onError: (e) => toast.error(e.message) }
    )
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading connections…</p>
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    )
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Provider connections</h3>
        <div className={CARD_CLASS}>
          {data?.connections.map((connection) => (
            <div key={connection.id} className={cn(CONNECTION_ROW, 'gap-3')}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{connection.name}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {connection.userId ? (connection.ownerName ?? 'Personal') : 'Global'}
                  {connection.accountLabel ? ` · ${connection.accountLabel}` : ''}
                  {connection.managed ? ' · Managed by your Platform login' : ''}
                  {!connection.isConfigured ? ' · Not configured' : ''}
                </div>
                <ProviderUsage connection={connection} />
              </div>
              <ConnectionRowMenu
                connection={connection}
                deleting={mutation.isPending}
                onEdit={() => setEditing(connection)}
                onDelete={() =>
                  mutation.mutate(
                    { path: `/${connection.id}`, method: 'DELETE' },
                    { onError: (e) => toast.error(e.message) }
                  )
                }
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditing('pick')}
            className={cn(CONNECTION_ROW, 'w-full gap-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:bg-muted/50')}
          >
            <Plus className="h-4 w-4" />
            Add connection
          </button>
        </div>
        <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
          {/* Neither step has a description; say so rather than leave a dangling aria-describedby. */}
          <DialogContent className="gap-8 p-10 sm:max-w-2xl" aria-describedby={undefined}>
            {editing === 'pick' && <ProviderPicker onPick={(provider) => setEditing({ provider })} />}
            {editing && editing !== 'pick' && (
              <ConnectionEditor
                key={'id' in editing ? editing.id : `new:${editing.provider}`}
                existing={'id' in editing ? editing : undefined}
                initialProvider={'id' in editing ? undefined : editing.provider}
                userId={isAuthMode ? (user?.id ?? null) : null}
                admin={!isAuthMode || isAdmin}
                modelPricing={settings?.modelPricing ?? {}}
                catalogFor={(provider) =>
                  settings?.llmProviderStatus.find((p) => p.id === provider)?.builtinCatalog ?? []
                }
                onClose={() => setEditing(null)}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
      {(!isAuthMode || isAdmin) && (
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Global settings</h3>
          <div className={CARD_CLASS}>
            {data && (
              <>
                <div className="py-3 px-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-xs font-medium">App default</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Used by every agent that doesn&apos;t set its own model.</p>
                  </div>
                  <SettingsModelSelect
                    model={data.defaultSelection?.model}
                    llmProviderId={data.defaultSelection?.llmProviderId}
                    globalOnly
                    disabled={mutation.isPending}
                    includeEffort
                    effort={settings?.models?.agentEffort}
                    onEffortChange={(agentEffort) => updateSettings.mutate({ models: { agentEffort } })}
                    onModelChange={() => {}}
                    onSelectionChange={(s) => changeDefault('default', s)}
                  />
                </div>
                <div className="py-3 px-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-xs font-medium">Summarizer</span>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Writes session titles and notification summaries.</p>
                    {data.defaultSelection && !data.summarizerSelection && !defaultRequiresSummarizer && <p className="text-[11px] text-muted-foreground mt-0.5">Using app default</p>}
                    {defaultRequiresSummarizer && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">This app default requires a separate API-capable summarizer.</p>
                    )}
                  </div>
                  <SettingsModelSelect
                    model={summarizerSelection?.model}
                    llmProviderId={summarizerSelection?.llmProviderId}
                    globalOnly
                    directApiOnly
                    disabled={mutation.isPending}
                    onModelChange={() => {}}
                    onSelectionChange={(s) => changeDefault('summarizer', s)}
                    appDefault={{
                      // An app default that can't summarize needs its own summarizer, so there's nothing to fall back to.
                      isOverride: !!data.summarizerSelection && !defaultRequiresSummarizer,
                      onUseAppDefault: () => changeDefault('summarizer', null),
                      label: 'Use app default',
                      hideSettingsLink: true,
                    }}
                  />
                </div>
              </>
            )}
            <div className="py-3 px-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <label htmlFor="llm-tool-search" className="text-xs font-medium">
                  Tool search
                </label>
                <p className="text-[11px] text-muted-foreground mt-0.5">Load tools only when needed to save context.</p>
              </div>
              <Switch
                id="llm-tool-search"
                checked={settings?.enableToolSearch !== false}
                onCheckedChange={(enableToolSearch) => updateSettings.mutate({ enableToolSearch })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
function ConnectionRowMenu({
  connection,
  deleting,
  onEdit,
  onDelete,
}: {
  connection: ConnectionInfo
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const deleteDisabled = !connection.canDelete || deleting
  const blockedReason = connection.deletionBlockedReason ?? (deleting ? 'Wait for the current change to finish.' : undefined)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Actions for ${connection.name}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        {connection.canManage && (
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onEdit()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted text-left"
          >
            <Pencil className="h-4 w-4" />
            Edit
          </button>
        )}
        <button
          type="button"
          disabled={deleteDisabled}
          onClick={() => {
            setOpen(false)
            onDelete()
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted text-left text-destructive disabled:pointer-events-none disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
        {deleteDisabled && blockedReason && (
          <p className="px-2 pb-1.5 pt-0.5 text-[11px] text-muted-foreground">{blockedReason}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
// A form field with its label beside the control rather than above it.
function FieldRow({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <label htmlFor={htmlFor} className="w-28 shrink-0 text-sm">{label}</label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
function ClaudeSetupTokenSteps() {
  return (
    <SetupPanel
      title="Setup instructions"
      data-testid="claude-setup-token-steps"
      notes={[
        'The token is checked on your first agent message. If it expires, run the command again and edit this connection.',
        'Pick a separate API-capable summarizer if this becomes the app default.',
      ]}
    >
      <SetupSteps
        steps={[
          <>
            <span>In a terminal with Claude Code installed, run:</span>
            <CopyableValue value="claude setup-token" label="Copy command" />
          </>,
          'Sign in with your Claude subscription in the browser window that opens.',
          'Paste the token it prints into Subscription token above.',
        ]}
      />
    </SetupPanel>
  )
}
function ProviderPicker({ onPick }: { onPick: (provider: LlmProviderId) => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Select a provider to add</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2" data-testid="llm-provider-picker">
        {(Object.keys(providers) as (keyof typeof providers)[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => onPick(id)}
            className="flex items-start gap-4 rounded-xl border p-5 text-left transition-colors hover:border-muted-foreground/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* The AWS logo's wordmark is near-black, so its tile stays light in dark mode. */}
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background', id === 'bedrock' && 'dark:bg-white')}>
              <ProviderLogo provider={id} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{providers[id]}</span>
              <span className="block text-xs leading-relaxed text-muted-foreground mt-1">{providerDescriptions[id]}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  )
}
function ConnectionEditor({
  existing,
  initialProvider,
  userId,
  admin,
  catalogFor,
  modelPricing,
  onClose,
}: {
  existing?: ConnectionInfo
  initialProvider?: LlmProviderId
  userId: string | null
  admin: boolean
  modelPricing: GlobalModelPricing
  catalogFor: (provider: LlmProviderId) => ConnectionInfo['catalog']
  onClose: () => void
}) {
  const formId = useId()
  const updateSettings = useUpdateSettings()
  const mutation = useConnectionMutation()
  // Fixed for the editor's lifetime: a new connection's provider is chosen on the picker step.
  const provider: LlmProviderId = existing?.provider ?? initialProvider ?? 'anthropic'
  const [name, setName] = useState(existing?.name ?? '')
  const [owner, setOwner] = useState<string | null>(existing?.userId ?? (admin ? null : userId))
  const [apiKey, setApiKey] = useState('')
  const [oauthLoginId, setOAuthLoginId] = useState<string>()
  const [accountLabel, setAccountLabel] = useState(existing?.accountLabel)
  const connected = useCallback((id: string, label: string) => {
    setOAuthLoginId(id)
    setAccountLabel(label)
    setName(current => current.trim() ? current : `${provider === 'codex-subscription' ? 'Codex' : 'Grok'} - ${label}`)
  }, [provider])
  const [apiFormat, setApiFormat] = useState<NonNullable<ConnectionConfig['apiFormat']>>(existing?.apiFormat ?? 'messages')
  const [chatTokenLimitField, setChatTokenLimitField] = useState<NonNullable<ConnectionConfig['chatTokenLimitField']>>(existing?.chatTokenLimitField ?? 'max_completion_tokens')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [runtimeEnv, setRuntimeEnv] = useState<Record<string, string | null | undefined>>(
    Object.fromEntries((existing?.customEnvVarKeys ?? []).map(key => [key, undefined])),
  )
  const [envName, setEnvName] = useState('')
  const [envValue, setEnvValue] = useState('')
  // Subscriptions check their token on first use instead; managed connections have nothing to enter.
  const canValidate = !existing?.managed && provider !== 'claude-subscription' && provider !== 'grok-subscription' && provider !== 'codex-subscription'
  // A new connection has nothing to check until a credential is entered; a saved one validates its stored credential.
  const hasCredentialToValidate = !!existing || apiKey.trim() !== '' || (provider === 'bedrock' && accessKey.trim() !== '' && secretKey.trim() !== '')
  // null marks a removed variable (sent so the server deletes it); undefined is a saved value left unchanged.
  const envEntries = Object.entries(runtimeEnv).filter(([, value]) => value !== null)
  const addEnvVar = () => {
    const key = envName.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return toast.error('Enter a valid environment variable name')
    if (isReservedEnvVar(key)) return toast.error(`${key} is reserved for the runtime`)
    if (Object.hasOwn(runtimeEnv, key) && runtimeEnv[key] !== null) return toast.error('That variable already exists')
    setRuntimeEnv(previous => ({ ...previous, [key]: envValue }))
    setEnvName('')
    setEnvValue('')
  }
  const [region, setRegion] = useState(existing?.region ?? 'us-east-1')
  const [overrides, setOverrides] = useState<CatalogOverrideEntry[]>(existing?.modelOverrides ?? [])
  const catalog = withGlobalModelPricing(mergeCatalog(catalogFor(provider), overrides), modelPricing)
  const [browserModel, setBrowserModel] = useState(existing?.browserModel ?? '')
  const [dashboardModel, setDashboardModel] = useState(existing?.dashboardModel ?? '')
  const save = async (validate = false) => {
    const apiKeys: ConnectionConfig['apiKeys'] = {}
    if (apiKey) {
      if (provider === 'anthropic') apiKeys.anthropicApiKey = apiKey
      if (provider === 'claude-subscription') apiKeys.claudeSubscriptionToken = apiKey.trim()
      if (provider === 'openrouter') apiKeys.openrouterApiKey = apiKey
      if (provider === 'generic') apiKeys.genericApiKey = apiKey
      if (provider === 'bedrock') apiKeys.bedrockApiKey = apiKey
    }
    if (provider === 'generic' && (!existing || baseUrl !== (existing.baseUrl ?? ''))) apiKeys.genericBaseUrl = baseUrl
    if (provider === 'bedrock') {
      if (!existing || region !== (existing.region ?? 'us-east-1')) apiKeys.bedrockRegion = region
      if (accessKey && secretKey && !apiKey) apiKeys.bedrockApiKey = ''
      if (accessKey) apiKeys.bedrockAccessKeyId = accessKey
      if (secretKey) apiKeys.bedrockSecretAccessKey = secretKey
    }
    try {
      const connection = {
        name: name || providers[provider as keyof typeof providers],
        provider,
        userId: owner,
        oauthLoginId,
        config: { apiKeys, ...(provider === 'generic' ? { apiFormat, chatTokenLimitField } : {}), runtimeEnv: Object.fromEntries(Object.entries(runtimeEnv).filter(([, value]) => value !== undefined)) },
        modelOverrides: overrides,
        browserModel: browserModel || null,
        dashboardModel: dashboardModel || null,
      }
      if (validate) {
        const result = await mutation.mutateAsync({
          path: '/validate',
          body: { id: existing?.id, connection },
        })
        if (result.valid) toast.success('Connection works')
        else toast.error(result.error ?? 'Validation failed')
        return
      }
      await mutation.mutateAsync({
        path: existing ? `/${existing.id}` : '',
        method: existing ? 'PUT' : 'POST',
        body: connection,
      })
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save connection')
    }
  }
  return (
    <form
      data-testid="llm-connection-editor"
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <DialogHeader>
        <DialogTitle>{existing ? `Edit ${existing.name}` : `Set up ${providers[provider as keyof typeof providers] ?? 'provider'} connection`}</DialogTitle>
      </DialogHeader>
      <label htmlFor={`${formId}-name`} className="grid gap-2 text-sm">
        Connection name
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Name this connection, e.g. ${nameExamples[provider as keyof typeof providers] ?? 'Work account'}`}
        />
      </label>
      {!existing && userId && admin && (
        <FieldRow label="Available to" htmlFor={`${formId}-owner`}>
          <Select
            value={owner ?? EVERYONE}
            onValueChange={(value) => { setOwner(value === EVERYONE ? null : value); setOAuthLoginId(undefined); setAccountLabel(undefined) }}
          >
            <SelectTrigger id={`${formId}-owner`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERYONE}>Everyone</SelectItem>
              <SelectItem value={userId}>Only me</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      )}
      {provider !== 'platform' && provider !== 'grok-subscription' && provider !== 'codex-subscription' && (
        <div className="grid gap-2 text-sm">
          <label htmlFor={`${formId}-apiKey`}>{provider === 'claude-subscription' ? 'Subscription token' : 'API key'}</label>
          <div className="flex gap-2">
            <Input
              id={`${formId}-apiKey`}
              className="flex-1"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={existing ? 'Leave blank to keep current credential' : provider === 'claude-subscription' ? 'Paste setup-token output' : 'API key'}
              required={provider === 'claude-subscription' && !existing}
            />
            {canValidate && (
              <Button type="button" variant="outline" disabled={mutation.isPending || !hasCredentialToValidate} onClick={() => void save(true)}>
                Validate
              </Button>
            )}
          </div>
        </div>
      )}
      {provider === 'claude-subscription' && <ClaudeSetupTokenSteps />}
      {(provider === 'grok-subscription' || provider === 'codex-subscription') && <SubscriptionSignIn provider={provider === 'codex-subscription' ? 'codex' : 'grok'} key={`${provider}:${owner ?? 'global'}`} connectionId={existing?.id} userId={owner} accountLabel={accountLabel} onConnected={connected} />}
      {provider === 'generic' && (
        <div className="grid gap-2 text-sm">
          <label htmlFor={`${formId}-apiFormat`}>API format</label>
          <Select value={apiFormat} onValueChange={value => setApiFormat(value as typeof apiFormat)}>
            <SelectTrigger id={`${formId}-apiFormat`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="messages">Anthropic Messages</SelectItem>
              <SelectItem value="chat-completions">OpenAI Chat Completions</SelectItem>
              <SelectItem value="responses">OpenAI Responses</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {provider === 'generic' && apiFormat === 'chat-completions' && (
        <div className="grid gap-2 text-sm">
          <label htmlFor={`${formId}-tokenLimit`}>Token limit parameter</label>
          <Select value={chatTokenLimitField} onValueChange={value => setChatTokenLimitField(value as typeof chatTokenLimitField)}>
            <SelectTrigger id={`${formId}-tokenLimit`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="max_completion_tokens">max_completion_tokens (OpenAI)</SelectItem>
              <SelectItem value="max_tokens">max_tokens (legacy compatible endpoints)</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">Use max_tokens if your endpoint does not accept max_completion_tokens.</span>
        </div>
      )}
      {provider === 'generic' && (
        <label htmlFor={`${formId}-baseUrl`} className="grid gap-2 text-sm">
          Base URL
          <Input
            id={`${formId}-baseUrl`}
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}
      {provider === 'bedrock' && (
        <>
          <label htmlFor={`${formId}-region`} className="grid gap-2 text-sm">
            AWS region
            <Input
              id={`${formId}-region`}
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-accessKey`} className="grid gap-2 text-sm">
            AWS access key (optional)
            <Input
              id={`${formId}-accessKey`}
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-secretKey`} className="grid gap-2 text-sm">
            AWS secret key
            <Input
              id={`${formId}-secretKey`}
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
            />
          </label>
        </>
      )}
      <div className="grid gap-2 text-sm">
        Model Defaults
        <div className="overflow-hidden rounded-lg border divide-y divide-border/50" data-testid="connection-default-models">
          {([
            { label: 'Browser model', description: 'Runs web browsing for agents.', model: browserModel, onPick: setBrowserModel },
            // Stored as the dashboard model; users know dashboards as agentic apps.
            { label: 'Agentic app model', description: 'Builds and edits agentic apps.', model: dashboardModel, onPick: setDashboardModel },
          ]).map(({ label, description, model, onPick }) => (
            <div key={label} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-xs font-medium">{label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
              </div>
              <ModelPickerPopover
                catalog={catalog}
                model={model}
                onPick={onPick}
                emptyLabel="Use session model"
              />
            </div>
          ))}
        </div>
      </div>
      <Collapsible className="grid gap-2 text-sm" data-testid="connection-advanced">
        <CollapsibleTrigger
          data-testid="connection-advanced-trigger"
          className="flex w-fit items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          Advanced Settings
          <ChevronDown className="h-4 w-4 shrink-0 opacity-70 transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden rounded-lg border divide-y divide-border/50">
          <div data-testid="connection-env-editor">
            <div className="flex flex-col px-4 py-3">
              <span className="flex items-center gap-2 text-xs font-medium">
                Environment variables
                {envEntries.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">{envEntries.length}</span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground">Set only when this connection is used. Saved values stay hidden.</span>
            </div>
            <div className="space-y-3 px-4 pb-4">
              {envEntries.length > 0 && (
                <div className="divide-y divide-border/50 rounded-md border">
                  {envEntries.map(([key, value]) => (
                    <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 py-1.5 pl-3 pr-1.5" data-testid="connection-env-row">
                      <span className="truncate font-mono text-xs" title={key}>{key}</span>
                      <Input
                        aria-label={`Value for ${key}`}
                        type="password"
                        autoComplete="new-password"
                        className="h-8 font-mono text-xs"
                        value={value ?? ''}
                        placeholder={value === undefined ? 'Saved value (unchanged)' : 'Value'}
                        onChange={e => setRuntimeEnv(previous => ({ ...previous, [key]: e.target.value }))}
                      />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" aria-label={`Remove ${key}`}
                        onClick={() => setRuntimeEnv(previous => ({ ...previous, [key]: null }))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
                <Input aria-label="Variable name" placeholder="NAME" className="h-8 font-mono text-xs"
                  value={envName} onChange={e => setEnvName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEnvVar() } }} />
                <Input aria-label="Variable value" type="password" autoComplete="new-password" placeholder="Value" className="h-8 font-mono text-xs"
                  value={envValue} onChange={e => setEnvValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEnvVar() } }} />
                <Button type="button" variant="outline" size="sm" className="h-8" aria-label="Add variable" onClick={addEnvVar}>
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            </div>
          </div>
          {provider !== 'platform' && (
            <CatalogEditor
              providerId={provider}
              llmProviderId={existing?.id}
              supportsModelSearch={!!existing && (provider === 'openrouter' || provider === 'generic' || provider === 'grok-subscription' || provider === 'codex-subscription')}
              builtinCatalog={catalogFor(provider)}
              effectiveCatalog={catalog}
              modelCatalog={{ [provider]: { overrides } }}
              modelPricing={modelPricing}
              canEditPricing={admin}
              disabled={mutation.isPending || updateSettings.isPending}
              pricingNote={provider === 'claude-subscription' || provider === 'grok-subscription' || provider === 'codex-subscription'
                ? 'Costs shown for this subscription are API-equivalent estimates, not what you are charged.'
                : undefined}
              onChange={({ modelCatalog, modelPricing: prices }) => {
                if (modelCatalog) setOverrides(modelCatalog[provider]?.overrides ?? [])
                if (admin && prices) updateSettings.mutate({ modelPricing: prices }, {
                  onError: (error) => toast.error(error.error ?? 'Could not update global model pricing'),
                })
              }}
            />
          )}
        </CollapsibleContent>
      </Collapsible>
      <DialogFooter className="pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending || ((provider === 'grok-subscription' || provider === 'codex-subscription') && !oauthLoginId && !existing?.isConfigured)}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}
