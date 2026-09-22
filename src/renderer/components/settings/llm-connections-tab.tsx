import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import { withGlobalModelPricing } from '@shared/lib/llm-provider/global-pricing'
import type { GlobalModelPricing } from '@shared/lib/llm-provider/global-pricing-schema'
import { useId, useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { useUser } from '@renderer/context/user-context'
import { useModelSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useLlmConnections, useConnectionMutation } from '@renderer/hooks/use-llm-connections'
import { SettingsModelSelect } from './settings-model-select'
import { CatalogEditor } from './model-catalog/catalog-editor'
import { mergeCatalog } from '@shared/lib/llm-provider/catalog-merge'
import type { CatalogOverrideEntry } from '@shared/lib/llm-provider/model-catalog-schema'
import type {
  ConnectionInfo,
  ConnectionConfig,
  ModelSelection,
} from '@shared/lib/llm-provider/connection-schema'
import type { LlmProviderId } from '@shared/lib/llm-provider/provider-types'

const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
const providers = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  bedrock: 'AWS Bedrock',
  generic: 'Generic',
}
export function LlmConnectionsTab() {
  const { data, isLoading, error } = useLlmConnections()
  const { data: settings } = useModelSettings()
  const updateSettings = useUpdateSettings()
  const { user, isAdmin, isAuthMode } = useUser()
  const mutation = useConnectionMutation()
  const [editing, setEditing] = useState<ConnectionInfo | 'new' | null>(null)
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
      {(!isAuthMode || isAdmin) && data && (
        <div className="rounded-xl border divide-y">
          <div className="flex items-center justify-between p-4 gap-3">
            <span className="text-sm">App default</span>
            <SettingsModelSelect
              model={data.defaultSelection?.model}
              llmProviderId={data.defaultSelection?.llmProviderId}
              globalOnly
              includeEffort
              effort={settings?.models?.agentEffort}
              onEffortChange={(agentEffort) => updateSettings.mutate({ models: { agentEffort } })}
              onModelChange={() => {}}
              onSelectionChange={(s) => changeDefault('default', s)}
            />
          </div>
          <div className="flex items-center justify-between p-4 gap-3">
            <span className="text-sm">Summarizer</span>
            <div className="flex items-center gap-2">
              <SettingsModelSelect
                model={(data.summarizerSelection ?? data.defaultSelection)?.model}
                llmProviderId={(data.summarizerSelection ?? data.defaultSelection)?.llmProviderId}
                globalOnly
                onModelChange={() => {}}
                onSelectionChange={(s) => changeDefault('summarizer', s)}
              />
              {data.summarizerSelection && (
                <Button variant="ghost" size="sm" onClick={() => changeDefault('summarizer', null)}>
                  Use app default
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {(!isAuthMode || isAdmin) && (
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="llm-tool-search" className="text-sm">
            Tool search
          </label>
          <Switch
            id="llm-tool-search"
            checked={settings?.enableToolSearch !== false}
            onCheckedChange={(enableToolSearch) => updateSettings.mutate({ enableToolSearch })}
          />
        </div>
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Connect accounts and choose which one each session uses.
        </p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 h-4 w-4" />
          Add connection
        </Button>
      </div>
      {data?.connections.map((connection) => (
        <div key={connection.id} className="rounded-xl border p-4 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{connection.name}</div>
            <div className="text-xs text-muted-foreground">
              {connection.userId ? (connection.ownerName ?? 'Personal') : 'Global'}
              {connection.managed ? ' · Managed by your Platform login' : ''}
              {!connection.isConfigured ? ' · Not configured' : ''}
            </div>
          </div>
          {connection.canManage && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${connection.name}`}
              onClick={() => setEditing(connection)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
          )}
          {connection.canDelete && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${connection.name}`}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate(
                  { path: `/${connection.id}`, method: 'DELETE' },
                  { onError: (e) => toast.error(e.message) }
                )
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      {editing && (
        <ConnectionEditor
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? undefined : editing}
          userId={isAuthMode ? (user?.id ?? null) : null}
          admin={!isAuthMode || isAdmin}
          modelPricing={settings?.modelPricing ?? {}}
          catalogFor={(provider) =>
            settings?.llmProviderStatus.find((p) => p.id === provider)?.builtinCatalog ?? []
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
function ConnectionEditor({
  existing,
  userId,
  admin,
  catalogFor,
  modelPricing,
  onClose,
}: {
  existing?: ConnectionInfo
  userId: string | null
  admin: boolean
  modelPricing: GlobalModelPricing
  catalogFor: (provider: LlmProviderId) => ConnectionInfo['catalog']
  onClose: () => void
}) {
  const formId = useId()
  const updateSettings = useUpdateSettings()
  const mutation = useConnectionMutation()
  const [provider, setProvider] = useState<LlmProviderId>(existing?.provider ?? 'anthropic')
  const [name, setName] = useState(existing?.name ?? '')
  const [owner, setOwner] = useState<string | null>(existing?.userId ?? (admin ? null : userId))
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [accessKey, setAccessKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [runtimeEnv, setRuntimeEnv] = useState<Record<string, string | null | undefined>>(
    Object.fromEntries((existing?.customEnvVarKeys ?? []).map(key => [key, undefined])),
  )
  const [envName, setEnvName] = useState('')
  const [envValue, setEnvValue] = useState('')
  const [region, setRegion] = useState(existing?.region ?? 'us-east-1')
  const [overrides, setOverrides] = useState<CatalogOverrideEntry[]>(existing?.modelOverrides ?? [])
  const catalog = withGlobalModelPricing(mergeCatalog(catalogFor(provider), overrides), modelPricing)
  const [browserModel, setBrowserModel] = useState(existing?.browserModel ?? '')
  const [dashboardModel, setDashboardModel] = useState(existing?.dashboardModel ?? '')
  const save = async (validate = false) => {
    const apiKeys: ConnectionConfig['apiKeys'] = {}
    if (apiKey) {
      if (provider === 'anthropic') apiKeys.anthropicApiKey = apiKey
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
        config: { apiKeys, runtimeEnv: Object.fromEntries(Object.entries(runtimeEnv).filter(([, value]) => value !== undefined)) },
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
      className="rounded-xl border p-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h3 className="font-medium">{existing ? `Edit ${existing.name}` : 'Add connection'}</h3>
      <label htmlFor={`${formId}-name`} className="block text-sm">
        Name
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Connection name"
        />
      </label>
      {!existing && (
        <div className="flex gap-3">
          <label className="grid gap-1 text-sm">
            Provider
            <select
              className={selectClass}
              value={provider}
              onChange={(e) => {
                const next = e.target.value as LlmProviderId
                setProvider(next)
                setOverrides([])
              }}
            >
              {Object.entries(providers).map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {userId && admin && (
            <label className="grid gap-1 text-sm">
              Available to
              <select
                className={selectClass}
                value={owner ?? ''}
                onChange={(e) => setOwner(e.target.value || null)}
              >
                <option value="">Everyone</option>
                <option value={userId}>Only me</option>
              </select>
            </label>
          )}
        </div>
      )}
      {provider !== 'platform' && (
        <label htmlFor={`${formId}-apiKey`} className="block text-sm">
          API key
          <Input
            id={`${formId}-apiKey`}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing ? 'Leave blank to keep current key' : 'API key'}
          />
        </label>
      )}
      {provider === 'generic' && (
        <label htmlFor={`${formId}-baseUrl`} className="block text-sm">
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
          <label htmlFor={`${formId}-region`} className="block text-sm">
            AWS region
            <Input
              id={`${formId}-region`}
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-accessKey`} className="block text-sm">
            AWS access key (optional)
            <Input
              id={`${formId}-accessKey`}
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
            />
          </label>
          <label htmlFor={`${formId}-secretKey`} className="block text-sm">
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
      <details className="rounded-lg border p-3" data-testid="connection-env-editor">
        <summary className="cursor-pointer text-sm font-medium">Custom environment variables</summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Apply only when this connection is selected. Saved values are hidden; leave them unchanged to keep them.
        </p>
        <div className="mt-3 space-y-2">
          {Object.entries(runtimeEnv).filter(([, value]) => value !== null).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2" data-testid="connection-env-row">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={key}>{key}</span>
              <Input
                aria-label={`Value for ${key}`}
                type="password"
                autoComplete="new-password"
                className="flex-1 font-mono text-sm"
                value={value ?? ''}
                placeholder={value === undefined ? 'Saved value (unchanged)' : 'Value'}
                onChange={e => setRuntimeEnv(previous => ({ ...previous, [key]: e.target.value }))}
              />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${key}`}
                onClick={() => setRuntimeEnv(previous => ({ ...previous, [key]: null }))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input aria-label="Variable name" placeholder="ANTHROPIC_BASE_URL" className="font-mono text-sm"
              value={envName} onChange={e => setEnvName(e.target.value)} />
            <Input aria-label="Variable value" type="password" autoComplete="new-password" placeholder="Value"
              value={envValue} onChange={e => setEnvValue(e.target.value)} />
            <Button type="button" variant="outline" onClick={() => {
              const key = envName.trim()
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return toast.error('Enter a valid environment variable name')
              if (isReservedEnvVar(key)) return toast.error(`${key} is reserved for the runtime`)
              if (Object.hasOwn(runtimeEnv, key) && runtimeEnv[key] !== null) return toast.error('That variable already exists')
              setRuntimeEnv(previous => ({ ...previous, [key]: envValue }))
              setEnvName('')
              setEnvValue('')
            }}>Add variable</Button>
          </div>
        </div>
      </details>
      {provider !== 'platform' && (
        <CatalogEditor
          providerId={provider}
          llmProviderId={existing?.id}
          supportsModelSearch={!!existing && (provider === 'openrouter' || provider === 'generic')}
          builtinCatalog={catalogFor(provider)}
          effectiveCatalog={catalog}
          modelCatalog={{ [provider]: { overrides } }}
          modelPricing={modelPricing}
          canEditPricing={admin}
          disabled={mutation.isPending || updateSettings.isPending}
          onChange={({ modelCatalog, modelPricing: prices }) => {
            if (modelCatalog) setOverrides(modelCatalog[provider]?.overrides ?? [])
            if (admin && prices) updateSettings.mutate({ modelPricing: prices }, {
              onError: (error) => toast.error(error.error ?? 'Could not update global model pricing'),
            })
          }}
        />
      )}
      {(['Browser', 'Dashboard'] as const).map((label) => (
        <label key={label} className="grid gap-1 text-sm">
          {label} model
          <select
            className={selectClass}
            value={label === 'Browser' ? browserModel : dashboardModel}
            onChange={(e) =>
              label === 'Browser'
                ? setBrowserModel(e.target.value)
                : setDashboardModel(e.target.value)
            }
          >
            <option value="">Use session model</option>
            {catalog.map((m) => (
              <option value={m.id} key={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          Save
        </Button>
        {!existing?.managed && (
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => void save(true)}
          >
            Validate
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
