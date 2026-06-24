import { useMemo, useState } from 'react'
import { ChevronDown, Plus, Settings, Trash2 } from 'lucide-react'
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { familyDisplayName } from '@renderer/components/messages/model-family-list'
import type { LlmProviderId } from '@shared/lib/config/settings'
import type {
  CatalogOverrideEntry,
  ModelCatalogSettings,
  ModelDefinition,
} from '@shared/lib/llm-provider'
import {
  cleanOverride,
  groupModelsByFamily,
  modelFromOverride,
  priceLabel,
  providerOverrides,
  replaceOverride,
  setProviderOverrides,
} from './catalog-overrides'
import { CustomModelDialog } from './custom-model-dialog'
import { BuiltinPricingDialog } from './builtin-pricing-dialog'

const ROW_PRICE_CLASS = 'w-28 text-right text-[11px] text-muted-foreground tabular-nums'

type CustomDialogState = { mode: 'add' } | { mode: 'edit'; model: ModelDefinition } | null

interface CatalogRowProps {
  model: ModelDefinition
  priceText: string
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  onCustomize: () => void
  onRemove?: () => void
}

/** One model row: enable checkbox, identity, always-visible actions, aligned price. */
function CatalogRow({
  model,
  priceText,
  enabled,
  disabled,
  onToggle,
  onCustomize,
  onRemove,
}: CatalogRowProps) {
  return (
    <div className="grid gap-2 px-4 py-2 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 items-center gap-2">
        <Checkbox
          aria-label={`Enable ${model.label}`}
          data-testid={`catalog-toggle-${model.id}`}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(checked) => onToggle(checked === true)}
        />
        <ModelIcon icon={model.icon} className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{model.label}</div>
          <div className="truncate text-[11px] text-muted-foreground">{model.id}</div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {/* Fixed-width slot so prices stay aligned whether a row has 1 or 2 actions. */}
        <div className="flex w-16 items-center justify-end gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={onRemove ? `Edit ${model.label}` : `Edit pricing for ${model.label}`}
            data-testid={`catalog-customize-${model.id}`}
            disabled={disabled}
            onClick={onCustomize}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${model.label}`}
              data-testid={`catalog-remove-custom-${model.id}`}
              disabled={disabled}
              onClick={onRemove}
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <span className={ROW_PRICE_CLASS}>{priceText}</span>
      </div>
    </div>
  )
}

export interface CatalogEditorProps {
  providerId: LlmProviderId
  builtinCatalog: ModelDefinition[]
  effectiveCatalog: ModelDefinition[]
  modelCatalog: ModelCatalogSettings | undefined
  supportsModelSearch?: boolean
  disabled?: boolean
  onChange: (modelCatalog: ModelCatalogSettings) => void
}

/**
 * Per-provider model catalog editor: disable built-ins, override their display
 * pricing, and add/edit custom models. Collapsed behind a disclosure so the
 * provider card stays light until a user opts into catalog management.
 */
export function CatalogEditor({
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

  const [customDialog, setCustomDialog] = useState<CustomDialogState>(null)
  const [editingBuiltin, setEditingBuiltin] = useState<ModelDefinition | null>(null)
  const [modelPendingDeletion, setModelPendingDeletion] = useState<ModelDefinition | null>(null)

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

  // Add and edit share this: a clean override replaces the entry by id, keeping
  // a custom model's disabled state across edits.
  const submitCustomModel = (entry: CatalogOverrideEntry) => {
    const wasDisabled = overrideById.get(entry.id)?.disabled === true
    upsertOverride(cleanOverride({ ...entry, ...(wasDisabled ? { disabled: true } : {}) }), entry.id)
  }

  const saveBuiltinPricing = (
    model: ModelDefinition,
    pricing: { inputPerMtok: number; outputPerMtok: number },
  ) => {
    const current = overrideById.get(model.id)
    upsertOverride(cleanOverride({ ...current, id: model.id, pricing }), model.id)
  }

  const resetBuiltinPricing = (model: ModelDefinition) => {
    const current = overrideById.get(model.id)
    if (!current) return
    const rest = { ...current }
    delete rest.pricing
    upsertOverride(cleanOverride(rest), model.id)
  }

  const confirmRemoveCustomModel = () => {
    if (!modelPendingDeletion) return
    persistOverrides(overrides.filter((override) => override.id !== modelPendingDeletion.id))
    setModelPendingDeletion(null)
  }

  return (
    <div className="-mx-4 -mb-6 border-t border-border/50" data-testid="model-catalog-editor">
      <Collapsible>
        <CollapsibleTrigger
          data-testid="catalog-disclosure-trigger"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span className="flex flex-col">
            <span className="text-xs font-medium">Model catalog</span>
            <span className="text-[11px] text-muted-foreground">
              Customize pricing, disable models, or add your own
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="flex justify-end px-4 pb-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="catalog-open-add-custom-model"
              disabled={disabled}
              onClick={() => setCustomDialog({ mode: 'add' })}
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
                    return (
                      <CatalogRow
                        key={model.id}
                        model={model}
                        priceText={priceLabel(override?.pricing ?? model.pricing)}
                        enabled={override?.disabled !== true}
                        disabled={disabled}
                        onToggle={(enabled) => updateBuiltinDisabled(model, enabled)}
                        onCustomize={() => setEditingBuiltin(model)}
                      />
                    )
                  })}
                </div>
              </div>
            ))}

            {customModels.length > 0 && (
              <div className="py-2">
                <div className="px-4 pb-1 text-[11px] font-medium text-muted-foreground">Custom</div>
                <div className="divide-y divide-border/30">
                  {customModels.map((model) => (
                    <CatalogRow
                      key={model.id}
                      model={model}
                      priceText={priceLabel(model.pricing)}
                      enabled={overrideById.get(model.id)?.disabled !== true}
                      disabled={disabled}
                      onToggle={(enabled) => updateCustomDisabled(model, enabled)}
                      onCustomize={() => setCustomDialog({ mode: 'edit', model })}
                      onRemove={() => setModelPendingDeletion(model)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

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

      <CustomModelDialog
        open={customDialog !== null}
        mode={customDialog?.mode ?? 'add'}
        initialModel={customDialog?.mode === 'edit' ? customDialog.model : null}
        providerId={providerId}
        supportsModelSearch={supportsModelSearch}
        disabled={disabled}
        onOpenChange={(open) => !open && setCustomDialog(null)}
        onSubmit={submitCustomModel}
      />

      <BuiltinPricingDialog
        model={editingBuiltin}
        overridePricing={editingBuiltin ? overrideById.get(editingBuiltin.id)?.pricing : undefined}
        disabled={disabled}
        onOpenChange={(open) => !open && setEditingBuiltin(null)}
        onSave={(pricing) => editingBuiltin && saveBuiltinPricing(editingBuiltin, pricing)}
        onReset={() => editingBuiltin && resetBuiltinPricing(editingBuiltin)}
      />
    </div>
  )
}
