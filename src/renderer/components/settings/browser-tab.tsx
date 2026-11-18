import { useState, type ReactNode } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@shared/lib/utils/cn'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { apiFetch } from '@renderer/lib/api'
import { Check, Loader2, Lock } from 'lucide-react'
import { RequestError } from '@shared/lib/tools/requests/request-error'
import type { HostBrowserProviderId, BrowserbaseStealthOs } from '@shared/lib/config/settings'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import { PasswordManagersSettings } from './password-managers-settings'
import { useSteelCredentials, type SteelCredentialsForm } from '@renderer/hooks/use-steel-credentials'
import { useTabtenderCredentials, type TabtenderCredentialsForm } from '@renderer/hooks/use-tabtender-credentials'

// Value used for "Container (built-in)" — no host browser provider
const CONTAINER_VALUE = '__container__'

// Preset tiers for the max-tabs picker. No 1: popup/OAuth flows need a second tab.
const MAX_TABS_OPTIONS = [5, 10, 20]

const CARD_CLASS = 'rounded-card border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

const HOST_DESCRIPTIONS: Record<string, ReactNode> = {
  [CONTAINER_VALUE]: 'Built-in headless browser that runs inside each agent’s container.',
  chrome: 'Google Chrome on this computer, with a separate profile for each agent. Nothing from your own Chrome profiles is shared.',
  browserbase: (
    <>
      Remote cloud browser that reduces bot detection and supports persistent sessions.
      <br />
      Requires a Browserbase account.
    </>
  ),
  platform: 'Managed cloud browser using your Platform account.',
  steel: (
    <>
      Remote cloud browser with a persistent profile for each agent, so agents stay signed in.
      <br />
      Requires a Steel account.
    </>
  ),
  tabtender: (
    <>
      Your own browser server: native Chrome on a Mac or Windows machine you run, with a persistent profile for each agent.
      <br />
      Requires a running{' '}
      <a href="https://github.com/SkillfulAgents/tabtender" target="_blank" rel="noreferrer" className="underline underline-offset-2">Tab Tender</a>
      {' '}server.
    </>
  ),
}

interface FieldRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
  htmlFor?: string
  /** Stack the control under the label below `md` — for wide controls (selects,
      text inputs) that would otherwise crush the label on mobile. */
  stack?: boolean
}

/** The row anatomy shared by card rows and expanded-card fields: name +
    supporting line on the left, control on the right. */
function FieldRow({ name, subtitle, right, htmlFor, stack }: FieldRowProps) {
  const Name = htmlFor ? 'label' : 'div'
  return (
    <div className={cn('flex gap-3', stack ? 'flex-col items-stretch md:flex-row md:items-center' : 'items-center')}>
      <div className="min-w-0 flex-1">
        <Name htmlFor={htmlFor} className={cn('text-xs font-medium truncate block', htmlFor ? 'cursor-pointer' : 'cursor-default')}>{name}</Name>
        {subtitle && <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>}
      </div>
      <div className={cn('flex items-center gap-2 shrink-0', stack && 'w-full md:w-auto')}>{right}</div>
    </div>
  )
}

interface SettingRowProps {
  name: string
  subtitle: ReactNode
  right: ReactNode
  htmlFor?: string
}

function SettingRow({ name, subtitle, right, htmlFor }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <FieldRow name={name} subtitle={subtitle} right={right} htmlFor={htmlFor} />
    </div>
  )
}

interface HostCardProps {
  id: string
  name: string
  description?: ReactNode
  selected: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  children?: ReactNode
}

/** Radio card that expands its provider-specific settings when selected —
    mirrors ProviderCard from the LLM provider tab. */
function HostCard({
  id,
  name,
  description,
  selected,
  disabled = false,
  disabledReason,
  onSelect,
  children,
}: HostCardProps) {
  return (
    <div
      className={`rounded-card border bg-background transition-colors ${
        selected ? 'border-primary' : disabled ? 'opacity-60' : 'hover:border-muted-foreground/40'
      }`}
      data-testid={`browser-host-card-${id === CONTAINER_VALUE ? 'container' : id}`}
    >
      <button
        type="button"
        role="radio"
        onClick={disabled ? undefined : onSelect}
        disabled={disabled}
        className="w-full flex items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
      >
        <div
          className={`mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
            selected ? 'border-primary' : 'border-muted-foreground/40'
          }`}
        >
          {selected && <div className="h-2 w-2 rounded-full bg-primary" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {disabled && disabledReason && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Lock className="h-3 w-3" />
                {disabledReason}
              </span>
            )}
          </div>
          {description && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{description}</div>
          )}
        </div>
      </button>

      {/* Expanded settings area when selected */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          selected && children ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {/* Only mount when selected: a collapsed grid-rows-[0fr] still leaves
              inputs in the DOM and keyboard tab order, so render conditionally. */}
          {selected && children && (
            <div className="px-4 pb-6 pt-5 border-t border-border/50">{children}</div>
          )}
        </div>
      </div>
    </div>
  )
}

export function BrowserTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const { track } = useAnalyticsTracking()

  // Optimistic local state
  const [hostProvider, setHostProvider] = useState<string | null>(null)
  const [browserbaseApiKey, setBrowserbaseApiKey] = useState('')
  const [browserbaseProjectId, setBrowserbaseProjectId] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const steelCredentials = useSteelCredentials()
  const tabtenderCredentials = useTabtenderCredentials()

  const effectiveProvider = hostProvider ?? settings?.app?.hostBrowserProvider ?? CONTAINER_VALUE

  const providers = settings?.hostBrowserStatus?.providers ?? []

  // Values stored by the old free-form input (1–20) may fall outside the presets;
  // surface them so the trigger doesn't render empty.
  const maxTabs = settings?.app?.maxBrowserTabs ?? 10
  const maxTabsIsCustom = !MAX_TABS_OPTIONS.includes(maxTabs)

  const handleSelectProvider = (value: string) => {
    const providerId = value === CONTAINER_VALUE ? null : value as HostBrowserProviderId
    setHostProvider(value)
    track('browser_host_changed', { using: value === CONTAINER_VALUE ? 'container' : value })
    updateSettings.mutate({
      app: { hostBrowserProvider: providerId as HostBrowserProviderId | undefined },
    })
  }

  // Rendered inside both the Browserbase and Platform cards — platform-managed
  // sessions run on Browserbase too, so the same session knobs apply.
  const sessionSettings = (
    <BrowserbaseSessionSettings
      advancedStealth={settings?.app?.browserbaseAdvancedStealth ?? false}
      stealthOs={settings?.app?.browserbaseStealthOs}
      proxies={settings?.app?.browserbaseProxies ?? false}
      proxyCountry={settings?.app?.browserbaseProxyCountry ?? ''}
      proxyState={settings?.app?.browserbaseProxyState ?? ''}
      proxyCity={settings?.app?.browserbaseProxyCity ?? ''}
      disabled={isLoading}
      onUpdate={(updates) => updateSettings.mutate({ app: updates })}
    />
  )

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Browser Agent</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Browser Agent Model"
            subtitle="Model used for the web browser subagent"
            right={
              <SettingsModelSelect
                model={settings?.models?.browserModel}
                onModelChange={(value) => updateSettings.mutate({ models: { browserModel: value } })}
                disabled={isLoading}
              />
            }
          />
          <SettingRow
            name="Max Browser Tabs"
            subtitle="Maximum number of browser tabs the agent can have open at once (default: 10)"
            htmlFor="max-browser-tabs"
            right={
              <Select
                value={String(maxTabs)}
                onValueChange={(value) => {
                  updateSettings.mutate({ app: { maxBrowserTabs: parseInt(value, 10) } })
                }}
                disabled={isLoading}
              >
                <SelectTrigger id="max-browser-tabs" className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {maxTabsIsCustom && (
                    <SelectItem value={String(maxTabs)}>{maxTabs} (custom)</SelectItem>
                  )}
                  {MAX_TABS_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </div>
      </div>

      <PasswordManagersSettings />

      {/* Host selection — radio cards, expanded card shows provider settings */}
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Browser Host</h3>
        <div role="radiogroup" aria-label="Browser host" className="space-y-3">
          <HostCard
            id={CONTAINER_VALUE}
            name="Container (built-in)"
            description={HOST_DESCRIPTIONS[CONTAINER_VALUE]}
            selected={effectiveProvider === CONTAINER_VALUE}
            disabled={isLoading}
            onSelect={() => handleSelectProvider(CONTAINER_VALUE)}
          >
            <FieldRow
              name="High-Resolution Rendering"
              subtitle="Render pages at 2x for a sharper live preview. Uses more CPU and bandwidth, and websites see a 2x display. Applies the next time an agent starts."
              htmlFor="container-browser-high-dpi"
              right={
                <Switch
                  id="container-browser-high-dpi"
                  checked={settings?.app?.containerBrowserHighDpi ?? false}
                  onCheckedChange={(checked) => {
                    updateSettings.mutate({ app: { containerBrowserHighDpi: checked } })
                  }}
                  disabled={isLoading}
                />
              }
            />
          </HostCard>

          {providers.map((provider) => {
            const unavailable =
              !provider.available && (provider.id === 'chrome' || provider.id === 'platform')
            return (
              <HostCard
                key={provider.id}
                id={provider.id}
                name={provider.name}
                description={HOST_DESCRIPTIONS[provider.id]}
                selected={effectiveProvider === provider.id}
                disabled={unavailable || isLoading}
                disabledReason={unavailable ? provider.reason : undefined}
                onSelect={() => handleSelectProvider(provider.id)}
              >
                {provider.id === 'chrome' ? (
                  <FieldRow
                    name="Headless Mode"
                    subtitle="Run Chrome without a visible window. Prevents Chrome from stealing focus."
                    htmlFor="chrome-headless"
                    right={
                      <Switch
                        id="chrome-headless"
                        checked={settings?.app?.chromeHeadless ?? false}
                        onCheckedChange={(checked) => {
                          updateSettings.mutate({ app: { chromeHeadless: checked } })
                        }}
                        disabled={isLoading}
                      />
                    }
                  />
                ) : provider.id === 'browserbase' ? (
                  <div className="space-y-4">
                    <BrowserbaseSettings
                      layout="rows"
                      apiKey={browserbaseApiKey}
                      projectId={browserbaseProjectId}
                      onApiKeyChange={(v) => { setBrowserbaseApiKey(v); setValidationResult(null) }}
                      onProjectIdChange={(v) => { setBrowserbaseProjectId(v); setValidationResult(null) }}
                      isValidating={isValidating}
                      validationResult={validationResult}
                      hasSavedCredentials={
                        !!providers.find((p) => p.id === 'browserbase')?.available
                        || !!settings?.apiKeyStatus?.browserbase?.isConfigured
                      }
                      credentialSource={settings?.apiKeyStatus?.browserbase?.source}
                      disabled={isLoading}
                      onValidateAndSave={async () => {
                        if (!browserbaseApiKey.trim() || !browserbaseProjectId.trim()) return
                        setIsValidating(true)
                        setValidationResult(null)

                        try {
                          const res = await apiFetch('/api/settings/validate-browserbase', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              apiKey: browserbaseApiKey.trim(),
                              projectId: browserbaseProjectId.trim(),
                            }),
                          })
                          const result = await res.json()
                          setValidationResult(result)

                          if (result.valid) {
                            await updateSettings.mutateAsync({
                              apiKeys: {
                                browserbaseApiKey: browserbaseApiKey.trim(),
                                browserbaseProjectId: browserbaseProjectId.trim(),
                              },
                            })
                            // Clear inputs so the button hides — saved state is shown via placeholder
                            setBrowserbaseApiKey('')
                            setBrowserbaseProjectId('')
                          }
                        } catch {
                          setValidationResult({ valid: false, error: 'Failed to validate credentials' })
                        } finally {
                          setIsValidating(false)
                        }
                      }}
                      onRemove={async () => {
                        setIsValidating(true)
                        try {
                          await updateSettings.mutateAsync({
                            apiKeys: {
                              browserbaseApiKey: '',
                              browserbaseProjectId: '',
                            },
                          })
                          setBrowserbaseApiKey('')
                          setBrowserbaseProjectId('')
                          setValidationResult(null)
                        } finally {
                          setIsValidating(false)
                        }
                      }}
                    />
                    {sessionSettings}
                  </div>
                ) : provider.id === 'steel' ? (
                  <div className="space-y-4">
                    <SteelSettings
                      layout="rows"
                      form={steelCredentials}
                      hasSavedCredentials={!!settings?.apiKeyStatus?.steel?.isConfigured}
                      credentialSource={settings?.apiKeyStatus?.steel?.source}
                      disabled={isLoading}
                    />
                    <SteelSessionSettings
                      solveCaptcha={settings?.app?.steelSolveCaptcha ?? false}
                      proxies={settings?.app?.steelProxies ?? false}
                      proxyCountry={settings?.app?.steelProxyCountry ?? ''}
                      proxyState={settings?.app?.steelProxyState ?? ''}
                      proxyCity={settings?.app?.steelProxyCity ?? ''}
                      disabled={isLoading}
                      onUpdate={(updates) => updateSettings.mutate({ app: updates })}
                    />
                  </div>
                ) : provider.id === 'tabtender' ? (
                  <TabtenderSettings
                    layout="rows"
                    form={tabtenderCredentials}
                    hasSavedCredentials={!!settings?.apiKeyStatus?.tabtender?.isConfigured}
                    credentialSource={settings?.apiKeyStatus?.tabtender?.source}
                    disabled={isLoading}
                  />
                ) : provider.id === 'platform' ? (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">
                      Browser sessions run on Browserbase using your Platform account&apos;s
                      credentials — no API key configuration needed.
                    </p>
                    {sessionSettings}
                  </div>
                ) : null}
              </HostCard>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const STEALTH_OS_OPTIONS: Array<{ value: BrowserbaseStealthOs; label: string }> = [
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
  { value: 'mac', label: 'macOS' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'tablet', label: 'Tablet' },
]

const NO_OS_VALUE = '__none__'

interface ProxyLocation {
  country: string
  state: string
  city: string
}

interface ProxySettingsProps {
  /** Prefix of the controls' ids: `${idPrefix}-proxies`, `${idPrefix}-proxy-country`, … */
  idPrefix: string
  subtitle: ReactNode
  locationHint: string
  enabled: boolean
  location: ProxyLocation
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  /** One field changed, upper-cased. */
  onLocationChange: (location: Partial<ProxyLocation>) => void
}

const PROXY_LOCATION_FIELDS: Array<{ part: keyof ProxyLocation; label: string; placeholder: string; maxLength?: number }> = [
  { part: 'country', label: 'Country Code', placeholder: 'e.g. US', maxLength: 2 },
  { part: 'state', label: 'State', placeholder: 'e.g. NY', maxLength: 2 },
  { part: 'city', label: 'City', placeholder: 'e.g. NEW_YORK' },
]

/** A cloud browser's proxy switch and, while it is on, the optional proxy location (Browserbase, Steel). */
function ProxySettings({
  idPrefix,
  subtitle,
  locationHint,
  enabled,
  location,
  disabled,
  onEnabledChange,
  onLocationChange,
}: ProxySettingsProps) {
  return (
    <>
      <FieldRow
        name="Enable Proxies"
        subtitle={subtitle}
        htmlFor={`${idPrefix}-proxies`}
        right={
          <Switch
            id={`${idPrefix}-proxies`}
            checked={enabled}
            onCheckedChange={onEnabledChange}
            disabled={disabled}
          />
        }
      />

      {/* Proxy Geolocation (only when proxies are on) */}
      {enabled && (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">{locationHint}</p>
          <div className="grid grid-cols-3 gap-3">
            {PROXY_LOCATION_FIELDS.map(({ part, label, placeholder, maxLength }) => (
              <div key={part} className="space-y-1">
                <Label htmlFor={`${idPrefix}-proxy-${part}`} className="text-xs">{label}</Label>
                <Input
                  id={`${idPrefix}-proxy-${part}`}
                  placeholder={placeholder}
                  value={location[part]}
                  onChange={(e) => onLocationChange({ [part]: e.target.value.toUpperCase() })}
                  disabled={disabled}
                  maxLength={maxLength}
                  className="h-8"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

interface BrowserbaseSessionSettingsProps {
  advancedStealth: boolean
  stealthOs?: BrowserbaseStealthOs
  proxies: boolean
  proxyCountry: string
  proxyState: string
  proxyCity: string
  disabled: boolean
  onUpdate: (updates: Partial<{
    browserbaseAdvancedStealth: boolean
    browserbaseStealthOs: BrowserbaseStealthOs | undefined
    browserbaseProxies: boolean
    browserbaseProxyCountry: string
    browserbaseProxyState: string
    browserbaseProxyCity: string
  }>) => void
}

/** Browserbase session config, rendered inside the expanded host card — used by
    both the Browserbase card (below credentials) and the Platform card. */
function BrowserbaseSessionSettings({
  advancedStealth,
  stealthOs,
  proxies,
  proxyCountry,
  proxyState,
  proxyCity,
  disabled,
  onUpdate,
}: BrowserbaseSessionSettingsProps) {
  return (
    <div className="space-y-4">
      <FieldRow
        name="Advanced Stealth Mode"
        subtitle="Uses a custom Chromium browser to avoid bot detection. Requires Scale plan."
        htmlFor="bb-stealth"
        right={
          <Switch
            id="bb-stealth"
            checked={advancedStealth}
            onCheckedChange={(checked) => {
              onUpdate({
                browserbaseAdvancedStealth: checked,
                // Clear OS when disabling stealth
                ...(!checked && { browserbaseStealthOs: undefined }),
              })
            }}
            disabled={disabled}
          />
        }
      />

      {/* OS Selection (only when stealth is on) */}
      {advancedStealth && (
        <FieldRow
          name="Operating System"
          subtitle="Changes the user agent and browser environment signals to match the selected platform"
          htmlFor="bb-stealth-os"
          right={
            <Select
              value={stealthOs ?? NO_OS_VALUE}
              onValueChange={(value) => {
                onUpdate({
                  browserbaseStealthOs: value === NO_OS_VALUE ? undefined : value as BrowserbaseStealthOs,
                })
              }}
              disabled={disabled}
            >
              <SelectTrigger id="bb-stealth-os" className="h-8 w-[160px]">
                <SelectValue placeholder="Default (auto)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OS_VALUE}>Default (auto)</SelectItem>
                {STEALTH_OS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      )}

      <ProxySettings
        idPrefix="bb"
        subtitle="Route traffic through residential proxies for higher CAPTCHA success rates and geo-targeting"
        locationHint="Optionally specify a proxy location. Leave empty for best-effort US proxy."
        enabled={proxies}
        location={{ country: proxyCountry, state: proxyState, city: proxyCity }}
        disabled={disabled}
        onEnabledChange={(checked) => onUpdate({
          browserbaseProxies: checked,
          // Clear geolocation when disabling
          ...(!checked && { browserbaseProxyCountry: '', browserbaseProxyState: '', browserbaseProxyCity: '' }),
        })}
        onLocationChange={(location) => onUpdate({
          ...(location.country !== undefined && { browserbaseProxyCountry: location.country }),
          ...(location.state !== undefined && { browserbaseProxyState: location.state }),
          ...(location.city !== undefined && { browserbaseProxyCity: location.city }),
        })}
      />
    </div>
  )
}

export interface BrowserbaseSettingsProps {
  apiKey: string
  projectId: string
  onApiKeyChange: (value: string) => void
  onProjectIdChange: (value: string) => void
  isValidating: boolean
  validationResult: { valid: boolean; error?: string } | null
  hasSavedCredentials: boolean
  credentialSource?: 'settings' | 'env' | 'none'
  disabled: boolean
  onValidateAndSave: () => void
  onRemove: () => void
  /** 'rows' puts label + supporting text left, input right (settings tab).
      'stacked' (default) keeps label-above-input for narrow containers
      like the setup wizard's 480px column. */
  layout?: 'stacked' | 'rows'
}

export function BrowserbaseSettings({
  apiKey,
  projectId,
  onApiKeyChange,
  onProjectIdChange,
  isValidating,
  validationResult,
  hasSavedCredentials,
  credentialSource,
  disabled,
  onValidateAndSave,
  onRemove,
  layout = 'stacked',
}: BrowserbaseSettingsProps) {
  const hasInput = apiKey.trim().length > 0 && projectId.trim().length > 0
  const rows = layout === 'rows'

  const apiKeyInput = (
    <Input
      id="browserbase-api-key"
      type="password"
      placeholder={hasSavedCredentials ? '••••••••••••••••' : 'bb-api-...'}
      value={apiKey}
      onChange={(e) => onApiKeyChange(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', rows && 'h-8 w-full md:w-[340px]')}
    />
  )
  const projectIdInput = (
    <Input
      id="browserbase-project-id"
      type="text"
      placeholder={hasSavedCredentials ? '••••••••••••••••' : 'bb-proj-...'}
      value={projectId}
      onChange={(e) => onProjectIdChange(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', rows && 'h-8 w-full md:w-[340px]')}
    />
  )

  return (
    <div className="space-y-4">
      {hasSavedCredentials && (
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
            {credentialSource === 'env' ? 'Using environment variable' : 'Credentials saved'}
          </span>
        </div>
      )}

      {rows ? (
        <>
          <FieldRow
            name="API Key"
            subtitle="Secret key from your Browserbase dashboard"
            htmlFor="browserbase-api-key"
            stack
            right={apiKeyInput}
          />
          <FieldRow
            name="Project ID"
            subtitle="Found in your Browserbase project settings"
            htmlFor="browserbase-project-id"
            stack
            right={projectIdInput}
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="browserbase-api-key" className="font-normal text-muted-foreground">Browserbase API Key</Label>
            {apiKeyInput}
          </div>
          <div className="space-y-2">
            <Label htmlFor="browserbase-project-id" className="font-normal text-muted-foreground">Browserbase Project ID</Label>
            {projectIdInput}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        {hasInput && (
          <Button size="sm" onClick={onValidateAndSave} disabled={isValidating}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}
        {hasSavedCredentials && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRemove}
            disabled={isValidating}
          >
            Remove Saved Credentials
          </Button>
        )}
      </div>

      {validationResult && !validationResult.valid && (
        <RequestError message={validationResult.error || 'Invalid credentials'} />
      )}
      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          Credentials saved
        </p>
      )}
    </div>
  )
}

interface SteelSessionSettingsProps {
  solveCaptcha: boolean
  proxies: boolean
  proxyCountry: string
  proxyState: string
  proxyCity: string
  disabled: boolean
  onUpdate: (updates: Partial<{
    steelSolveCaptcha: boolean
    steelProxies: boolean
    steelProxyCountry: string
    steelProxyState: string
    steelProxyCity: string
  }>) => void
}

/** Steel session config, rendered in the expanded Steel card below the API key. */
function SteelSessionSettings({
  solveCaptcha,
  proxies,
  proxyCountry,
  proxyState,
  proxyCity,
  disabled,
  onUpdate,
}: SteelSessionSettingsProps) {
  return (
    <div className="space-y-4">
      <FieldRow
        name="CAPTCHA Solving"
        subtitle="Steel solves CAPTCHAs it finds on a page. On Steel's Launch plan this needs paid credits."
        htmlFor="steel-captcha"
        right={
          <Switch
            id="steel-captcha"
            checked={solveCaptcha}
            onCheckedChange={(checked) => onUpdate({ steelSolveCaptcha: checked })}
            disabled={disabled}
          />
        }
      />

      <ProxySettings
        idPrefix="steel"
        subtitle="Route traffic through Steel's residential proxies for geo-targeting and fewer blocks. On Steel's Launch plan this needs paid credits."
        locationHint="Optionally specify a proxy location. Leave empty to let Steel choose. State applies to the US only."
        enabled={proxies}
        location={{ country: proxyCountry, state: proxyState, city: proxyCity }}
        disabled={disabled}
        onEnabledChange={(checked) => onUpdate({
          steelProxies: checked,
          // Clear geolocation when disabling
          ...(!checked && { steelProxyCountry: '', steelProxyState: '', steelProxyCity: '' }),
        })}
        onLocationChange={(location) => onUpdate({
          ...(location.country !== undefined && { steelProxyCountry: location.country }),
          ...(location.state !== undefined && { steelProxyState: location.state }),
          ...(location.city !== undefined && { steelProxyCity: location.city }),
        })}
      />
    </div>
  )
}

export interface SteelSettingsProps {
  form: SteelCredentialsForm
  hasSavedCredentials: boolean
  credentialSource?: 'settings' | 'env' | 'none'
  disabled: boolean
  /** 'rows' puts label + supporting text left, input right (settings tab).
      'stacked' (default) keeps label-above-input for the setup wizard's narrow column. */
  layout?: 'stacked' | 'rows'
}

/** The Steel API key: enter and connect (checked with Steel before it is saved), or remove the saved one. */
export function SteelSettings({
  form,
  hasSavedCredentials,
  credentialSource,
  disabled,
  layout = 'stacked',
}: SteelSettingsProps) {
  const { apiKey, setApiKey, isValidating, validationResult, validateAndSave, remove } = form
  const hasInput = apiKey.trim().length > 0

  const apiKeyInput = (
    <Input
      id="steel-api-key"
      type="password"
      placeholder={hasSavedCredentials ? '••••••••••••••••' : 'ste-...'}
      value={apiKey}
      onChange={(e) => setApiKey(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', layout === 'rows' && 'h-8 w-full md:w-[340px]')}
    />
  )

  return (
    <div className="space-y-4">
      {hasSavedCredentials && (
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
            {credentialSource === 'env' ? 'Using environment variable' : 'API key saved'}
          </span>
        </div>
      )}

      {layout === 'rows' ? (
        <FieldRow
          name="API Key"
          subtitle="From the API Keys page of your Steel dashboard"
          htmlFor="steel-api-key"
          stack
          right={apiKeyInput}
        />
      ) : (
        <div className="space-y-2">
          <Label htmlFor="steel-api-key" className="font-normal text-muted-foreground">Steel API Key</Label>
          {apiKeyInput}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {hasInput && (
          <Button size="sm" onClick={validateAndSave} disabled={isValidating}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}
        {hasSavedCredentials && credentialSource !== 'env' && (
          <Button size="sm" variant="outline" onClick={remove} disabled={isValidating}>
            Remove Saved Key
          </Button>
        )}
      </div>

      {validationResult && !validationResult.valid && (
        <RequestError message={validationResult.error || 'Invalid API key'} />
      )}
      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          API key saved
        </p>
      )}
    </div>
  )
}

export interface TabtenderSettingsProps {
  form: TabtenderCredentialsForm
  hasSavedCredentials: boolean
  credentialSource?: 'settings' | 'env' | 'none'
  disabled: boolean
  /** 'rows' puts label + supporting text left, input right (settings tab).
      'stacked' (default) keeps label-above-input for the setup wizard's narrow column. */
  layout?: 'stacked' | 'rows'
}

/** The Tab Tender server URL and API key: enter and connect (checked with the server before they are saved), or remove them. */
export function TabtenderSettings({
  form,
  hasSavedCredentials,
  credentialSource,
  disabled,
  layout = 'stacked',
}: TabtenderSettingsProps) {
  const { url, setUrl, apiKey, setApiKey, isValidating, validationResult, validateAndSave, remove } = form
  const hasInput = url.trim().length > 0 && apiKey.trim().length > 0
  const rows = layout === 'rows'

  const urlInput = (
    <Input
      id="tabtender-url"
      type="url"
      inputMode="url"
      autoComplete="off"
      spellCheck={false}
      placeholder="https://browsers.example.com"
      value={url}
      onChange={(e) => setUrl(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', rows && 'h-8 w-full md:w-[340px]')}
    />
  )
  const apiKeyInput = (
    <Input
      id="tabtender-api-key"
      type="password"
      autoComplete="off"
      placeholder={hasSavedCredentials ? '••••••••••••••••' : 'tt_...'}
      value={apiKey}
      onChange={(e) => setApiKey(e.target.value)}
      disabled={disabled || isValidating}
      className={cn('bg-background', rows && 'h-8 w-full md:w-[340px]')}
    />
  )

  return (
    <div className="space-y-4">
      {hasSavedCredentials && (
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
            {credentialSource === 'env' ? 'Using environment variables' : 'Server connected'}
          </span>
        </div>
      )}

      {rows ? (
        <>
          <FieldRow
            name="Server URL"
            subtitle="Where this app reaches your Tab Tender server, e.g. its tunnel URL"
            htmlFor="tabtender-url"
            stack
            right={urlInput}
          />
          <FieldRow
            name="API Key"
            subtitle="From Tab Tender's Settings → API Key"
            htmlFor="tabtender-api-key"
            stack
            right={apiKeyInput}
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="tabtender-url" className="font-normal text-muted-foreground">Tab Tender Server URL</Label>
            {urlInput}
          </div>
          <div className="space-y-2">
            <Label htmlFor="tabtender-api-key" className="font-normal text-muted-foreground">Tab Tender API Key</Label>
            {apiKeyInput}
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        {hasInput && (
          <Button size="sm" onClick={validateAndSave} disabled={isValidating}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Checking...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}
        {hasSavedCredentials && credentialSource !== 'env' && (
          <Button size="sm" variant="outline" onClick={remove} disabled={isValidating}>
            Remove Server
          </Button>
        )}
      </div>

      {validationResult && !validationResult.valid && (
        <RequestError message={validationResult.error || 'Could not connect to the server'} />
      )}
      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          Server connected
        </p>
      )}
    </div>
  )
}
