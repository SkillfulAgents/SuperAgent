import { useEffect, useRef, useState } from 'react'
import { Search, Upload } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useProviderModelSearch } from '@renderer/hooks/use-settings'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
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
import type { LlmProviderId } from '@shared/lib/config/settings'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'
import type {
  CatalogOverrideEntry,
  ModelDefinition,
  ModelSearchResult,
} from '@shared/lib/llm-provider'
import { CurrencyPriceInput, LabeledTextInput } from './catalog-fields'
import { parseOptionalPrice, searchResultMeta } from './catalog-overrides'

/** Catalog fields that aren't directly editable in the form but are carried through. */
type CustomModelExtras = Partial<
  Pick<
    ModelDefinition,
    | 'blurb'
    | 'contextWindow'
    | 'supportsWebSearch'
    | 'supportsImageInput'
    | 'promptHints'
    | 'longContextPriceCliff'
  >
>

interface CustomModelForm {
  id: string
  label: string
  family: string
  icon: string
  inputPrice: string
  outputPrice: string
  efforts: EffortLevel[]
}

const BLANK_FORM: CustomModelForm = {
  id: '',
  label: '',
  family: '',
  icon: '',
  inputPrice: '',
  outputPrice: '',
  efforts: ['low', 'medium', 'high'],
}

function extrasFromModel(model: ModelDefinition): CustomModelExtras {
  return {
    blurb: model.blurb,
    contextWindow: model.contextWindow,
    supportsWebSearch: model.supportsWebSearch,
    supportsImageInput: model.supportsImageInput,
    promptHints: model.promptHints,
    longContextPriceCliff: model.longContextPriceCliff,
  }
}

function formFromModel(model: ModelDefinition): CustomModelForm {
  return {
    id: model.id,
    label: model.label,
    family: model.family ?? '',
    icon: model.icon ?? '',
    inputPrice: model.pricing?.inputPerMtok?.toString() ?? '',
    outputPrice: model.pricing?.outputPerMtok?.toString() ?? '',
    efforts: model.supportedEfforts,
  }
}

export interface CustomModelDialogProps {
  open: boolean
  mode: 'add' | 'edit'
  /** The model being edited (edit mode) — prefills the form and supplies carried-through extras. */
  initialModel?: ModelDefinition | null
  providerId: LlmProviderId
  supportsModelSearch?: boolean
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (entry: CatalogOverrideEntry) => void
}

/** Add/edit a custom model. Body is mounted only while open so each open starts fresh. */
export function CustomModelDialog(props: CustomModelDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <CustomModelDialogBody {...props} />}
    </Dialog>
  )
}

function CustomModelDialogBody({
  mode,
  initialModel,
  providerId,
  supportsModelSearch = false,
  disabled,
  onOpenChange,
  onSubmit,
}: CustomModelDialogProps) {
  const isEdit = mode === 'edit'
  const [form, setForm] = useState<CustomModelForm>(() =>
    isEdit && initialModel ? formFromModel(initialModel) : BLANK_FORM,
  )
  // Carried-through catalog fields, plus the id they belong to. When the user
  // edits the id away from that owner the extras are dropped on submit.
  const [extras, setExtras] = useState<CustomModelExtras>(() =>
    isEdit && initialModel ? extrasFromModel(initialModel) : {},
  )
  const [extrasOwnerId, setExtrasOwnerId] = useState<string | null>(
    isEdit && initialModel ? initialModel.id : null,
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [iconUploading, setIconUploading] = useState(false)
  const [iconUploadError, setIconUploadError] = useState<string | null>(null)
  const iconFileInputRef = useRef<HTMLInputElement>(null)

  const searchEnabled = supportsModelSearch && mode === 'add' && !disabled
  const providerModelSearch = useProviderModelSearch(providerId, debouncedQuery, {
    enabled: searchEnabled,
  })

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(searchQuery), 250)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const patch = (next: Partial<CustomModelForm>) => setForm((prev) => ({ ...prev, ...next }))

  const toggleEffort = (effort: EffortLevel, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      efforts: checked
        ? prev.efforts.includes(effort) ? prev.efforts : [...prev.efforts, effort]
        : prev.efforts.filter((level) => level !== effort),
    }))
  }

  const applySearchModel = (model: ModelSearchResult) => {
    setForm({
      id: model.id,
      label: model.label,
      family: model.family ?? '',
      icon: model.icon ?? '',
      inputPrice: model.pricing?.inputPerMtok?.toString() ?? '',
      outputPrice: model.pricing?.outputPerMtok?.toString() ?? '',
      efforts: model.supportedEfforts,
    })
    setExtras(extrasFromModel(model))
    setExtrasOwnerId(model.id)
  }

  const uploadIcon = async (file: File | undefined) => {
    if (!file) return
    setIconUploading(true)
    setIconUploadError(null)
    try {
      const formData = new FormData()
      formData.set('file', file)
      const response = await apiFetch('/api/settings/model-icons', { method: 'POST', body: formData })
      const payload = await response.json().catch(() => ({})) as { icon?: unknown; error?: unknown }
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to upload icon')
      }
      if (typeof payload.icon !== 'string' || payload.icon.trim() === '') {
        throw new Error('Upload response did not include an icon key')
      }
      patch({ icon: payload.icon })
    } catch (error) {
      setIconUploadError(error instanceof Error ? error.message : 'Failed to upload icon')
    } finally {
      setIconUploading(false)
      if (iconFileInputRef.current) iconFileInputRef.current.value = ''
    }
  }

  const id = form.id.trim()
  const label = form.label.trim()
  const inputPrice = parseOptionalPrice(form.inputPrice)
  const outputPrice = parseOptionalPrice(form.outputPrice)
  const inputInvalid = form.inputPrice.trim() !== '' && inputPrice === undefined
  const outputInvalid = form.outputPrice.trim() !== '' && outputPrice === undefined
  const hasPricing = inputPrice !== undefined && outputPrice !== undefined
  const canSubmit =
    id !== '' && label !== '' && form.efforts.length > 0 && !inputInvalid && !outputInvalid

  const submit = () => {
    if (!canSubmit) return
    const includeExtras = extrasOwnerId !== null && extrasOwnerId === id
    const entry: CatalogOverrideEntry = {
      id,
      label,
      family: form.family.trim() || undefined,
      icon: form.icon.trim() || undefined,
      supportedEfforts: form.efforts,
      ...(hasPricing ? { pricing: { inputPerMtok: inputPrice!, outputPerMtok: outputPrice! } } : {}),
      ...(includeExtras && extras.blurb ? { blurb: extras.blurb } : {}),
      ...(includeExtras && extras.contextWindow ? { contextWindow: extras.contextWindow } : {}),
      ...(includeExtras && extras.supportsWebSearch !== undefined
        ? { supportsWebSearch: extras.supportsWebSearch }
        : {}),
      ...(includeExtras && extras.supportsImageInput !== undefined
        ? { supportsImageInput: extras.supportsImageInput }
        : {}),
      ...(includeExtras && extras.promptHints ? { promptHints: extras.promptHints } : {}),
      ...(includeExtras && extras.longContextPriceCliff
        ? { longContextPriceCliff: extras.longContextPriceCliff }
        : {}),
    }
    onSubmit(entry)
    onOpenChange(false)
  }

  const results = providerModelSearch.data
  return (
    <DialogContent aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>{isEdit ? `Edit ${initialModel?.label ?? 'model'}` : 'Add custom model'}</DialogTitle>
      </DialogHeader>

      {searchEnabled && (
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
              aria-expanded={results !== undefined && results.length > 0}
              aria-controls="custom-model-provider-search-results"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Search models"
              disabled={disabled}
              className="h-8 pl-8 text-xs"
            />
          </div>
          {debouncedQuery.trim().length >= 2 && (
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
              ) : results && results.length > 0 ? (
                results.map((model) => {
                  const selected = extrasOwnerId === model.id
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
          value={form.id}
          onChange={(value) => patch({ id: value })}
          placeholder="model-id"
          disabled={disabled || isEdit}
        />
        <LabeledTextInput
          id="custom-model-label"
          label="Display label"
          value={form.label}
          onChange={(value) => patch({ label: value })}
          placeholder="Display label"
          disabled={disabled}
        />
        <LabeledTextInput
          id="custom-model-family"
          label="Family"
          value={form.family}
          onChange={(value) => patch({ family: value })}
          placeholder="family"
          disabled={disabled}
        />
        <div className="space-y-1.5">
          <Label htmlFor="custom-model-icon" className="text-xs text-foreground">Icon key</Label>
          <div className="flex gap-2">
            <Input
              id="custom-model-icon"
              value={form.icon}
              onChange={(event) => patch({ icon: event.currentTarget.value })}
              placeholder="openai or uploaded:..."
              disabled={disabled || iconUploading}
              aria-describedby={iconUploadError ? 'custom-model-icon-error' : undefined}
              className="h-8 text-xs"
            />
            <input
              ref={iconFileInputRef}
              type="file"
              accept="image/svg+xml,image/png,image/jpeg,image/webp"
              className="hidden"
              tabIndex={-1}
              aria-label="Upload model icon"
              data-testid="catalog-custom-icon-file"
              onChange={(event) => uploadIcon(event.currentTarget.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || iconUploading}
              aria-label="Upload model icon"
              data-testid="catalog-upload-custom-icon"
              onClick={() => iconFileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              {iconUploading ? 'Uploading' : 'Upload'}
            </Button>
          </div>
          {iconUploadError && (
            <div id="custom-model-icon-error" role="alert" className="text-[11px] text-destructive">
              {iconUploadError}
            </div>
          )}
        </div>
        <CurrencyPriceInput
          id="custom-model-input-price"
          label="Input price"
          value={form.inputPrice}
          onChange={(value) => patch({ inputPrice: value })}
          disabled={disabled}
        />
        <CurrencyPriceInput
          id="custom-model-output-price"
          label="Output price"
          value={form.outputPrice}
          onChange={(value) => patch({ outputPrice: value })}
          disabled={disabled}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-foreground">Supported efforts</legend>
        <div className="flex flex-wrap items-center gap-3">
          {EFFORT_LEVELS.map((effort) => (
            <label key={effort} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Checkbox
                checked={form.efforts.includes(effort)}
                disabled={disabled}
                onCheckedChange={(checked) => toggleEffort(effort, checked === true)}
              />
              {effort}
            </label>
          ))}
        </div>
      </fieldset>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="button"
          size="sm"
          data-testid={isEdit ? 'catalog-save-custom-model' : 'catalog-add-custom-model'}
          disabled={disabled || iconUploading || !canSubmit}
          onClick={submit}
        >
          {isEdit ? 'Save' : 'Add model'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
