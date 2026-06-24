import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { AlertTriangle, Lock, Plus, RotateCcw, Search, Settings, Trash2, Upload } from 'lucide-react'
import { useProviderModelSearch, useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { apiFetch } from '@renderer/lib/api'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { BedrockCredentialsInput } from './bedrock-credentials-input'
import { SettingsModelSelect } from './settings-model-select'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { familyDisplayName } from '@renderer/components/messages/model-family-list'
import type { LlmProviderId } from '@shared/lib/config/settings'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'
import type {
  CatalogOverrideEntry,
  ModelCatalogSettings,
  ModelDefinition,
  ModelSearchResult,
} from '@shared/lib/llm-provider'
import { modelDefinitionSchema } from '@shared/lib/llm-provider/model-catalog-schema'

const SIMPLE_PROVIDER_KEY_CONFIG: Record<string, {
  label: string
  placeholder: string
  envVarName: string
  apiKeySettingsField: 'anthropicApiKey' | 'openrouterApiKey'
}> = {
  anthropic: {
    label: 'Anthropic API Key',
    placeholder: 'sk-ant-...',
    envVarName: 'ANTHROPIC_API_KEY',
    apiKeySettingsField: 'anthropicApiKey',
  },
  openrouter: {
    label: 'OpenRouter API Key',
    placeholder: 'sk-or-...',
    envVarName: 'OPENROUTER_API_KEY',
    apiKeySettingsField: 'openrouterApiKey',
  },
}

const PROVIDER_DESCRIPTIONS: Partial<Record<LlmProviderId, string>> = {
  anthropic: 'Direct API access to Claude models.',
  openrouter: 'Multi-model access through a single API key.',
  bedrock: 'AWS-managed Claude inference with IAM or API key credentials.',
  platform: 'Use credentials provided by your Gamut account.',
}

const CARD_CLASS = 'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden'
const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'
const ROW_ACTIONS_CLASS =
  'flex items-center gap-1 opacity-0 translate-x-1 transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0'
const ROW_PRICE_CLASS = 'w-24 text-right text-[11px] text-muted-foreground'

function providerOverrides(
  modelCatalog: ModelCatalogSettings | undefined,
  providerId: LlmProviderId,
): CatalogOverrideEntry[] {
  return modelCatalog?.[providerId]?.overrides ?? []
}

function isEmptyOverride(entry: CatalogOverrideEntry): boolean {
  return Object.entries(entry).every(([key, value]) => key === 'id' || value === undefined)
}

function cleanOverride(entry: CatalogOverrideEntry): CatalogOverrideEntry | null {
  const cleaned = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined)
  ) as CatalogOverrideEntry
  return isEmptyOverride(cleaned) ? null : cleaned
}

function replaceOverride(
  overrides: CatalogOverrideEntry[],
  entry: CatalogOverrideEntry | null,
  id: string,
): CatalogOverrideEntry[] {
  const rest = overrides.filter((override) => override.id !== id)
  return entry ? [...rest, entry] : rest
}

function setProviderOverrides(
  modelCatalog: ModelCatalogSettings | undefined,
  providerId: LlmProviderId,
  overrides: CatalogOverrideEntry[],
): ModelCatalogSettings {
  const next: ModelCatalogSettings = { ...(modelCatalog ?? {}) }
  if (overrides.length === 0) {
    delete next[providerId]
  } else {
    next[providerId] = { overrides }
  }
  return next
}

function groupModelsByFamily(models: ModelDefinition[]) {
  const order: string[] = []
  const byFamily = new Map<string, ModelDefinition[]>()
  for (const model of models) {
    const family = model.family ?? 'other'
    if (!byFamily.has(family)) {
      byFamily.set(family, [])
      order.push(family)
    }
    byFamily.get(family)!.push(model)
  }
  return order.map((family) => ({ family, models: byFamily.get(family)! }))
}

function priceLabel(pricing: ModelDefinition['pricing']): string {
  if (!pricing) return 'No pricing'
  return `$${pricing.inputPerMtok}/$${pricing.outputPerMtok}`
}

function formatTokenWindow(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`
  return `${tokens} context`
}

function searchResultMeta(model: ModelSearchResult): string {
  return [
    formatTokenWindow(model.contextWindow),
    model.pricing ? priceLabel(model.pricing) : undefined,
  ].filter(Boolean).join(' · ')
}

function parseOptionalPrice(rawValue: string): number | undefined {
  if (rawValue.trim() === '') return undefined
  const value = Number(rawValue)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function modelFromOverride(entry: CatalogOverrideEntry): ModelDefinition | null {
  const model = { ...entry }
  delete model.disabled
  const parsed = modelDefinitionSchema.safeParse(model)
  return parsed.success ? parsed.data : null
}

interface CurrencyPriceInputProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  testId?: string
  disabled?: boolean
}

function CurrencyPriceInput({
  id,
  label,
  value,
  onChange,
  testId,
  disabled,
}: CurrencyPriceInputProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-foreground">{label}</Label>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
        >
          $
        </span>
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          aria-describedby={`${id}-unit`}
          data-testid={testId}
          disabled={disabled}
          className="h-8 pl-7 text-xs"
        />
      </div>
      <div id={`${id}-unit`} className="text-[11px] text-muted-foreground">USD per million tokens</div>
    </div>
  )
}

interface LabeledTextInputProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

function LabeledTextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: LabeledTextInputProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-foreground">{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="h-8 text-xs"
      />
    </div>
  )
}

interface SettingRowProps {
  name: string
  subtitle?: ReactNode
  right: ReactNode
  /** When set, the name renders as a <label> bound to the control with this id. */
  htmlFor?: string
}

function SettingRow({ name, subtitle, right, htmlFor }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="block text-xs font-medium truncate cursor-pointer">{name}</label>
          ) : (
            <div className="text-xs font-medium truncate">{name}</div>
          )}
          {subtitle && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">{right}</div>
      </div>
    </div>
  )
}

interface ModelEffortRowProps {
  name: string
  subtitle: string
  model: string | undefined
  /** Reasoning effort; only surfaced when `includeEffort` is true. */
  effort?: EffortLevel
  includeEffort?: boolean
  disabled?: boolean
  onModelChange: (model: string) => void
  onEffortChange?: (effort: EffortLevel) => void
}

/** SettingRow wrapper around the shared settings model (+ effort) selector. */
function ModelEffortRow({
  name,
  subtitle,
  model,
  effort,
  includeEffort,
  disabled,
  onModelChange,
  onEffortChange,
}: ModelEffortRowProps) {
  return (
    <SettingRow
      name={name}
      subtitle={subtitle}
      right={
        <SettingsModelSelect
          model={model}
          onModelChange={onModelChange}
          includeEffort={includeEffort}
          effort={effort}
          onEffortChange={onEffortChange}
          disabled={disabled}
        />
      }
    />
  )
}

interface ProviderCardProps {
  id: LlmProviderId
  name: string
  description?: string
  selected: boolean
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  children?: ReactNode
}

function ProviderCard({
  id,
  name,
  description,
  selected,
  disabled = false,
  disabledReason,
  onSelect,
  children,
}: ProviderCardProps) {
  return (
    <div
      className={`rounded-xl border bg-background transition-colors ${
        selected ? 'border-primary' : disabled ? 'opacity-60' : 'hover:border-muted-foreground/40'
      }`}
      data-testid={`llm-provider-card-${id}`}
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

      {/* Expanded credentials area when selected */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          selected ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          {/* Only mount when selected: a collapsed grid-rows-[0fr] still leaves
              inputs in the DOM and keyboard tab order, so render conditionally. */}
          {selected && (
            <div className="px-4 pb-6 pt-5 border-t border-border/50">{children}</div>
          )}
        </div>
      </div>
    </div>
  )
}

interface CatalogEditorProps {
  providerId: LlmProviderId
  builtinCatalog: ModelDefinition[]
  effectiveCatalog: ModelDefinition[]
  modelCatalog: ModelCatalogSettings | undefined
  supportsModelSearch?: boolean
  disabled?: boolean
  onChange: (modelCatalog: ModelCatalogSettings) => void
}

function CatalogEditor({
  providerId,
  builtinCatalog,
  effectiveCatalog,
  modelCatalog,
  supportsModelSearch = false,
  disabled,
  onChange,
}: CatalogEditorProps) {
  const overrides = useMemo(
    () => providerOverrides(modelCatalog, providerId),
    [modelCatalog, providerId],
  )
  const builtinIds = useMemo(
    () => new Set(builtinCatalog.map((model) => model.id)),
    [builtinCatalog],
  )
  const overrideById = useMemo(() => {
    const map = new Map<string, CatalogOverrideEntry>()
    for (const override of overrides) map.set(override.id, { ...map.get(override.id), ...override })
    return map
  }, [overrides])
  const groupedBuiltins = useMemo(() => groupModelsByFamily(builtinCatalog), [builtinCatalog])
  const customModels = useMemo(() => {
    const effectiveCustoms = effectiveCatalog.filter((model) => !builtinIds.has(model.id))
    const effectiveById = new Map(effectiveCustoms.map((model) => [model.id, model]))
    const customIds = effectiveCustoms.map((model) => model.id)

    for (const override of overrides) {
      if (!builtinIds.has(override.id) && !customIds.includes(override.id)) {
        customIds.push(override.id)
      }
    }

    return customIds
      .map((id) => effectiveById.get(id) ?? modelFromOverride(overrideById.get(id)!))
      .filter((model): model is ModelDefinition => model !== null)
  }, [builtinIds, effectiveCatalog, overrideById, overrides])

  const [customModalOpen, setCustomModalOpen] = useState(false)
  const [customId, setCustomId] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [customFamily, setCustomFamily] = useState('')
  const [customIcon, setCustomIcon] = useState('')
  const customIconFileInputRef = useRef<HTMLInputElement>(null)
  const [customIconUploading, setCustomIconUploading] = useState(false)
  const [customIconUploadError, setCustomIconUploadError] = useState<string | null>(null)
  const [customSearchQuery, setCustomSearchQuery] = useState('')
  const [debouncedCustomSearchQuery, setDebouncedCustomSearchQuery] = useState('')
  const [customSearchModel, setCustomSearchModel] = useState<ModelSearchResult | null>(null)
  const [customInputPrice, setCustomInputPrice] = useState('')
  const [customOutputPrice, setCustomOutputPrice] = useState('')
  const [customEfforts, setCustomEfforts] = useState<EffortLevel[]>(['low', 'medium', 'high'])
  const [editingModel, setEditingModel] = useState<ModelDefinition | null>(null)
  const [modelPendingDeletion, setModelPendingDeletion] = useState<ModelDefinition | null>(null)
  const [builtinInputPrice, setBuiltinInputPrice] = useState('')
  const [builtinOutputPrice, setBuiltinOutputPrice] = useState('')
  const providerModelSearch = useProviderModelSearch(providerId, debouncedCustomSearchQuery, {
    enabled: supportsModelSearch && customModalOpen && !disabled,
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedCustomSearchQuery(customSearchQuery)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [customSearchQuery])

  const persistOverrides = (nextOverrides: CatalogOverrideEntry[]) => {
    onChange(setProviderOverrides(modelCatalog, providerId, nextOverrides))
  }

  const upsertOverride = (entry: CatalogOverrideEntry | null, id: string) => {
    persistOverrides(replaceOverride(overrides, entry, id))
  }

  const updateBuiltinDisabled = (model: ModelDefinition, enabled: boolean) => {
    const current = overrideById.get(model.id)
    if (!enabled) {
      upsertOverride({ ...current, id: model.id, disabled: true }, model.id)
      return
    }

    if (!current) return
    const rest = { ...current }
    delete rest.disabled
    upsertOverride(cleanOverride(rest), model.id)
  }

  const updateCustomDisabled = (model: ModelDefinition, enabled: boolean) => {
    const current = overrideById.get(model.id) ?? model
    if (!enabled) {
      upsertOverride({ ...current, id: model.id, disabled: true }, model.id)
      return
    }

    const rest: CatalogOverrideEntry = { ...current, id: model.id }
    delete rest.disabled
    upsertOverride(cleanOverride(rest), model.id)
  }

  const openBuiltinModal = (model: ModelDefinition) => {
    const pricing = overrideById.get(model.id)?.pricing ?? model.pricing
    setEditingModel(model)
    setBuiltinInputPrice(pricing?.inputPerMtok?.toString() ?? '')
    setBuiltinOutputPrice(pricing?.outputPerMtok?.toString() ?? '')
  }

  const saveBuiltinPricing = () => {
    if (!editingModel) return
    const inputPerMtok = parseOptionalPrice(builtinInputPrice)
    const outputPerMtok = parseOptionalPrice(builtinOutputPrice)
    if (inputPerMtok === undefined || outputPerMtok === undefined) return

    const current = overrideById.get(editingModel.id)
    upsertOverride(
      cleanOverride({
        ...current,
        id: editingModel.id,
        pricing: { inputPerMtok, outputPerMtok },
      }),
      editingModel.id,
    )
    setEditingModel(null)
  }

  const resetBuiltinPricing = (model: ModelDefinition) => {
    const current = overrideById.get(model.id)
    if (!current) return
    const rest = { ...current }
    delete rest.pricing
    upsertOverride(cleanOverride(rest), model.id)
    setEditingModel(null)
  }

  const toggleCustomEffort = (effort: EffortLevel, checked: boolean) => {
    setCustomEfforts((current) => {
      if (checked) return current.includes(effort) ? current : [...current, effort]
      return current.filter((level) => level !== effort)
    })
  }

  const applySearchModel = (model: ModelSearchResult) => {
    setCustomSearchModel(model)
    setCustomId(model.id)
    setCustomLabel(model.label)
    setCustomFamily(model.family ?? '')
    setCustomIcon(model.icon ?? '')
    setCustomInputPrice(model.pricing?.inputPerMtok?.toString() ?? '')
    setCustomOutputPrice(model.pricing?.outputPerMtok?.toString() ?? '')
    setCustomEfforts(model.supportedEfforts)
  }

  const uploadCustomIcon = async (file: File | undefined) => {
    if (!file) return

    setCustomIconUploading(true)
    setCustomIconUploadError(null)
    try {
      const formData = new FormData()
      formData.set('file', file)
      const response = await apiFetch('/api/settings/model-icons', {
        method: 'POST',
        body: formData,
      })
      const payload = await response.json().catch(() => ({})) as { icon?: unknown; error?: unknown }
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to upload icon')
      }
      if (typeof payload.icon !== 'string' || payload.icon.trim() === '') {
        throw new Error('Upload response did not include an icon key')
      }
      setCustomIcon(payload.icon)
    } catch (error) {
      setCustomIconUploadError(error instanceof Error ? error.message : 'Failed to upload icon')
    } finally {
      setCustomIconUploading(false)
      if (customIconFileInputRef.current) customIconFileInputRef.current.value = ''
    }
  }

  const addCustomModel = () => {
    const id = customId.trim()
    const label = customLabel.trim()
    if (!id || !label || customEfforts.length === 0) return

    const inputPrice = customInputPrice.trim() === '' ? undefined : Number(customInputPrice)
    const outputPrice = customOutputPrice.trim() === '' ? undefined : Number(customOutputPrice)
    const hasPricing = inputPrice !== undefined && outputPrice !== undefined
    if (
      (inputPrice !== undefined && (!Number.isFinite(inputPrice) || inputPrice < 0)) ||
      (outputPrice !== undefined && (!Number.isFinite(outputPrice) || outputPrice < 0))
    ) {
      return
    }

    const entry: CatalogOverrideEntry = {
      id,
      label,
      family: customFamily.trim() || undefined,
      icon: customIcon.trim() || undefined,
      supportedEfforts: customEfforts,
      ...(hasPricing ? { pricing: { inputPerMtok: inputPrice!, outputPerMtok: outputPrice! } } : {}),
      ...(customSearchModel?.id === id && customSearchModel.blurb ? { blurb: customSearchModel.blurb } : {}),
      ...(customSearchModel?.id === id && customSearchModel.contextWindow
        ? { contextWindow: customSearchModel.contextWindow }
        : {}),
      ...(customSearchModel?.id === id && customSearchModel.supportsWebSearch !== undefined
        ? { supportsWebSearch: customSearchModel.supportsWebSearch }
        : {}),
      ...(customSearchModel?.id === id && customSearchModel.promptHints
        ? { promptHints: customSearchModel.promptHints }
        : {}),
      ...(customSearchModel?.id === id && customSearchModel.longContextPriceCliff
        ? { longContextPriceCliff: customSearchModel.longContextPriceCliff }
        : {}),
    }
    upsertOverride(entry, id)
    setCustomId('')
    setCustomLabel('')
    setCustomFamily('')
    setCustomIcon('')
    setCustomIconUploadError(null)
    setCustomSearchQuery('')
    setDebouncedCustomSearchQuery('')
    setCustomSearchModel(null)
    setCustomInputPrice('')
    setCustomOutputPrice('')
    setCustomEfforts(['low', 'medium', 'high'])
    setCustomModalOpen(false)
  }

  const removeCustomModel = (id: string) => {
    persistOverrides(overrides.filter((override) => override.id !== id))
  }

  const confirmRemoveCustomModel = () => {
    if (!modelPendingDeletion) return
    removeCustomModel(modelPendingDeletion.id)
    setModelPendingDeletion(null)
  }

  const canAddCustom = customId.trim() !== '' && customLabel.trim() !== '' && customEfforts.length > 0
  const canSaveBuiltinPricing =
    parseOptionalPrice(builtinInputPrice) !== undefined &&
    parseOptionalPrice(builtinOutputPrice) !== undefined

  return (
    <div className="-mx-4 -mb-6 border-t border-border/50" data-testid="model-catalog-editor">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="text-xs font-medium">Model catalog</div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="catalog-open-add-custom-model"
          disabled={disabled}
          onClick={() => {
            setCustomIconUploadError(null)
            setCustomModalOpen(true)
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add model
        </Button>
      </div>

      <div className="divide-y divide-border/50 border-t border-border/50">
        {groupedBuiltins.map((group) => (
          <div key={group.family} className="py-2">
            <div className="px-4 pb-1 text-[11px] font-medium text-muted-foreground">
              {group.family === 'other' ? 'Other' : familyDisplayName(group.family)}
            </div>
            <div className="divide-y divide-border/30">
              {group.models.map((model) => {
                const override = overrideById.get(model.id)
                const enabled = override?.disabled !== true
                const pricing = override?.pricing ?? model.pricing
                return (
                  <div
                    key={model.id}
                    className="group grid gap-2 px-4 py-2 md:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={`Enable ${model.label}`}
                        data-testid={`catalog-toggle-${model.id}`}
                        checked={enabled}
                        disabled={disabled}
                        onCheckedChange={(checked) => updateBuiltinDisabled(model, checked === true)}
                      />
                      <ModelIcon icon={model.icon} className="h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">{model.label}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{model.id}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <div className={ROW_ACTIONS_CLASS}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Customize ${model.label}`}
                          data-testid={`catalog-customize-${model.id}`}
                          disabled={disabled}
                          onClick={() => openBuiltinModal(model)}
                          className="h-7 w-7"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <span className={ROW_PRICE_CLASS}>{priceLabel(pricing)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {customModels.length > 0 && (
          <div className="py-2">
            <div className="px-4 pb-1 text-[11px] font-medium text-muted-foreground">Custom</div>
            <div className="divide-y divide-border/30">
              {customModels.map((model) => {
                const enabled = overrideById.get(model.id)?.disabled !== true
                return (
                  <div
                    key={model.id}
                    className="group grid gap-2 px-4 py-2 md:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={`Enable ${model.label}`}
                        data-testid={`catalog-toggle-${model.id}`}
                        checked={enabled}
                        disabled={disabled}
                        onCheckedChange={(checked) => updateCustomDisabled(model, checked === true)}
                      />
                      <ModelIcon icon={model.icon} className="h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">{model.label}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{model.id}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <div className={ROW_ACTIONS_CLASS}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Customize ${model.label}`}
                          data-testid={`catalog-customize-${model.id}`}
                          disabled={disabled}
                          onClick={() => openBuiltinModal(model)}
                          className="h-7 w-7"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${model.label}`}
                          data-testid={`catalog-remove-custom-${model.id}`}
                          disabled={disabled}
                          onClick={() => setModelPendingDeletion(model)}
                          className="h-7 w-7 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <span className={ROW_PRICE_CLASS}>{priceLabel(model.pricing)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>

      <AlertDialog
        open={modelPendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open) setModelPendingDeletion(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Custom Model</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{modelPendingDeletion?.label ?? 'this model'}&quot; from
              this provider catalog? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemoveCustomModel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Model
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={customModalOpen}
        onOpenChange={(open) => {
          if (!open) setCustomIconUploadError(null)
          setCustomModalOpen(open)
        }}
      >
        {customModalOpen && (
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Add custom model</DialogTitle>
            </DialogHeader>
            {supportsModelSearch && (
              <div className="space-y-2">
                <Label htmlFor="custom-model-provider-search" className="text-xs text-foreground">
                  Search provider models
                </Label>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="custom-model-provider-search"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={providerModelSearch.data !== undefined && providerModelSearch.data.length > 0}
                    aria-controls="custom-model-provider-search-results"
                    value={customSearchQuery}
                    onChange={(event) => setCustomSearchQuery(event.currentTarget.value)}
                    placeholder="Search models"
                    disabled={disabled}
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                {debouncedCustomSearchQuery.trim().length >= 2 && (
                  <div
                    id="custom-model-provider-search-results"
                    role="listbox"
                    aria-label="Provider model search results"
                    className="max-h-48 overflow-y-auto rounded-md border border-border/70 bg-background p-1"
                  >
                    {providerModelSearch.isLoading ? (
                      <div className="px-2 py-2 text-[11px] text-muted-foreground">Searching...</div>
                    ) : providerModelSearch.isError ? (
                      <div role="alert" className="px-2 py-2 text-[11px] text-destructive">
                        {providerModelSearch.error instanceof Error
                          ? providerModelSearch.error.message
                          : 'Failed to search provider models'}
                      </div>
                    ) : providerModelSearch.data && providerModelSearch.data.length > 0 ? (
                      providerModelSearch.data.map((model) => {
                        const selected = customSearchModel?.id === model.id
                        const meta = searchResultMeta(model)
                        return (
                          <button
                            key={model.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-testid={`catalog-search-result-${model.id}`}
                            className={`flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent ${
                              selected ? 'bg-accent' : ''
                            }`}
                            onClick={() => applySearchModel(model)}
                          >
                            <ModelIcon icon={model.icon} className="mt-0.5 h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">{model.label}</span>
                              <span className="block truncate text-[11px] text-muted-foreground">{model.id}</span>
                              {meta && (
                                <span className="block truncate text-[11px] text-muted-foreground">{meta}</span>
                              )}
                            </span>
                          </button>
                        )
                      })
                    ) : (
                      <div className="px-2 py-2 text-[11px] text-muted-foreground">No models found</div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <LabeledTextInput
                id="custom-model-id"
                label="Model ID"
                value={customId}
                onChange={setCustomId}
                placeholder="model-id"
                disabled={disabled}
              />
              <LabeledTextInput
                id="custom-model-label"
                label="Display label"
                value={customLabel}
                onChange={setCustomLabel}
                placeholder="Display label"
                disabled={disabled}
              />
              <LabeledTextInput
                id="custom-model-family"
                label="Family"
                value={customFamily}
                onChange={setCustomFamily}
                placeholder="family"
                disabled={disabled}
              />
              <div className="space-y-1.5">
                <Label htmlFor="custom-model-icon" className="text-xs text-foreground">Icon key</Label>
                <div className="flex gap-2">
                  <Input
                    id="custom-model-icon"
                    value={customIcon}
                    onChange={(event) => setCustomIcon(event.currentTarget.value)}
                    placeholder="openai or uploaded:..."
                    disabled={disabled || customIconUploading}
                    aria-describedby={customIconUploadError ? 'custom-model-icon-error' : undefined}
                    className="h-8 text-xs"
                  />
                  <input
                    ref={customIconFileInputRef}
                    type="file"
                    accept="image/svg+xml,image/png,image/jpeg,image/webp"
                    className="hidden"
                    tabIndex={-1}
                    aria-label="Upload model icon"
                    data-testid="catalog-custom-icon-file"
                    onChange={(event) => uploadCustomIcon(event.currentTarget.files?.[0])}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || customIconUploading}
                    aria-label="Upload model icon"
                    data-testid="catalog-upload-custom-icon"
                    onClick={() => customIconFileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {customIconUploading ? 'Uploading' : 'Upload'}
                  </Button>
                </div>
                {customIconUploadError && (
                  <div id="custom-model-icon-error" role="alert" className="text-[11px] text-destructive">
                    {customIconUploadError}
                  </div>
                )}
              </div>
              <CurrencyPriceInput
                id="custom-model-input-price"
                label="Input price"
                value={customInputPrice}
                onChange={setCustomInputPrice}
                disabled={disabled}
              />
              <CurrencyPriceInput
                id="custom-model-output-price"
                label="Output price"
                value={customOutputPrice}
                onChange={setCustomOutputPrice}
                disabled={disabled}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-foreground">Supported efforts</legend>
              <div className="flex flex-wrap items-center gap-3">
                {EFFORT_LEVELS.map((effort) => (
                  <label key={effort} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Checkbox
                      checked={customEfforts.includes(effort)}
                      disabled={disabled}
                      onCheckedChange={(checked) => toggleCustomEffort(effort, checked === true)}
                    />
                    {effort}
                  </label>
                ))}
              </div>
            </fieldset>
            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCustomModalOpen(false)}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                size="sm"
                data-testid="catalog-add-custom-model"
                disabled={disabled || customIconUploading || !canAddCustom}
                onClick={addCustomModel}
              >
                Add model
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={editingModel !== null} onOpenChange={(open) => !open && setEditingModel(null)}>
        {editingModel && (
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{`Customize ${editingModel.label}`}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 md:grid-cols-2">
              <CurrencyPriceInput
                id="builtin-model-input-price"
                label="Input price"
                value={builtinInputPrice}
                onChange={setBuiltinInputPrice}
                testId="catalog-builtin-price-input"
                disabled={disabled}
              />
              <CurrencyPriceInput
                id="builtin-model-output-price"
                label="Output price"
                value={builtinOutputPrice}
                onChange={setBuiltinOutputPrice}
                testId="catalog-builtin-price-output"
                disabled={disabled}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={`catalog-reset-pricing-${editingModel.id}`}
                disabled={disabled || overrideById.get(editingModel.id)?.pricing === undefined}
                onClick={() => resetBuiltinPricing(editingModel)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset pricing
              </Button>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingModel(null)}
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="button"
                size="sm"
                data-testid="catalog-save-builtin-pricing"
                disabled={disabled || !canSaveBuiltinPricing}
                onClick={saveBuiltinPricing}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

export function LlmTab() {
  const { data: settings, isLoading } = useSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const updateSettings = useUpdateSettings()

  const isPlatformConnected = platformAuth?.connected ?? false
  const activeProvider = (settings?.llmProvider ?? 'anthropic') as LlmProviderId
  const providerStatus = settings?.llmProviderStatus ?? []

  return (
    <div className="space-y-6">
      {/* Provider selection — radio cards, expanded card shows credentials + models */}
      <div className="space-y-3">
        <div role="radiogroup" aria-label="LLM provider" className="space-y-3">
        {providerStatus.map((provider) => {
          const isSelected = activeProvider === provider.id
          const platformLocked = provider.id === 'platform' && !isPlatformConnected
          const modelOptions = provider.catalog ?? []
          const builtinOptions = provider.builtinCatalog ?? modelOptions
          const keyConfig = SIMPLE_PROVIDER_KEY_CONFIG[provider.id]

          return (
            <ProviderCard
              key={provider.id}
              id={provider.id}
              name={provider.name}
              description={PROVIDER_DESCRIPTIONS[provider.id]}
              selected={isSelected}
              disabled={platformLocked || isLoading}
              disabledReason={platformLocked ? 'Requires Account login' : undefined}
              onSelect={() => updateSettings.mutate({ llmProvider: provider.id })}
            >
              {provider.id === 'platform' ? (
                <p className="text-xs text-muted-foreground">
                  {isPlatformConnected
                    ? 'Your account is providing credentials. Manage it from the Account settings tab.'
                    : 'Connect from the Account settings tab to use this provider.'}
                </p>
              ) : provider.id === 'bedrock' ? (
                <BedrockCredentialsInput
                  key="bedrock"
                  disabled={isLoading}
                  showNotConfiguredAlert={false}
                />
              ) : keyConfig ? (
                <ProviderApiKeyInput
                  key={provider.id}
                  providerId={provider.id}
                  label={keyConfig.label}
                  placeholder={keyConfig.placeholder}
                  envVarName={keyConfig.envVarName}
                  apiKeySettingsField={keyConfig.apiKeySettingsField}
                  disabled={isLoading}
                  showNotConfiguredAlert={false}
                />
              ) : null}

              {/* Model selection lives inside the selected provider since available models are provider-specific */}
              <div className="mt-6 -mx-4 border-t border-border/50">
                {modelOptions.length === 0 ? (
                  <p className="px-4 py-3 text-[11px] text-muted-foreground">
                    Configure credentials to load available models.
                  </p>
                ) : (
                  <div className="divide-y divide-border/50">
                    <ModelEffortRow
                      name="Default model"
                      subtitle="Model and effort new sessions start with, before any per-message override"
                      model={settings?.models?.agentModel}
                      effort={settings?.models?.agentEffort ?? 'medium'}
                      includeEffort
                      disabled={isLoading}
                      onModelChange={(model) => updateSettings.mutate({ models: { agentModel: model } })}
                      onEffortChange={(effort) => updateSettings.mutate({ models: { agentEffort: effort } })}
                    />
                    <ModelEffortRow
                      name="Summarizer model"
                      subtitle="Used for session name generation and API key validation"
                      model={settings?.models?.summarizerModel}
                      includeEffort={false}
                      disabled={isLoading}
                      onModelChange={(model) => updateSettings.mutate({ models: { summarizerModel: model } })}
                    />
                    <ModelEffortRow
                      name="Dashboard model"
                      subtitle="Used by the dashboard-builder subagent that creates and edits artifacts"
                      model={settings?.models?.dashboardBuilderModel}
                      includeEffort={false}
                      disabled={isLoading}
                      onModelChange={(model) => updateSettings.mutate({ models: { dashboardBuilderModel: model } })}
                    />
                  </div>
                )}
              </div>
              <CatalogEditor
                providerId={provider.id}
                builtinCatalog={builtinOptions}
                effectiveCatalog={modelOptions}
                modelCatalog={settings?.modelCatalog}
                supportsModelSearch={provider.capabilities?.modelSearch}
                disabled={isLoading}
                onChange={(modelCatalog) => updateSettings.mutate({ modelCatalog })}
              />
            </ProviderCard>
          )
        })}
        </div>

        {settings?.hasRunningAgents && (
          <div className="flex gap-2 rounded-md bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-500/90 leading-relaxed">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p>Running agents will use the previous provider until restarted.</p>
          </div>
        )}
      </div>

      {/* Advanced */}
      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>Advanced</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Tool search"
            htmlFor="enable-tool-search"
            subtitle="Load tool definitions on demand to save ~15-20K tokens per turn. Disable only when debugging. Requires Sonnet/Opus 4+; ignored on Haiku."
            right={
              <Switch
                id="enable-tool-search"
                checked={settings?.enableToolSearch !== false}
                onCheckedChange={(checked: boolean) => {
                  updateSettings.mutate({ enableToolSearch: checked })
                }}
                disabled={isLoading}
              />
            }
          />
        </div>
      </div>
    </div>
  )
}
