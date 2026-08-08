import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import { findCatalogModel } from '@renderer/components/messages/model-family-list'
import { useSettings, useUpdateSettings, type GlobalSettingsResponse } from '@renderer/hooks/use-settings'
import type { ModelDefinition, ProviderDefaultModelOption } from '@shared/lib/llm-provider'

/**
 * Match a stored id/alias to a curated option by model family. A pinned Opus
 * version should still light the Opus card; models outside the shortlist use
 * the Other card and the full catalog picker.
 */
export function findDefaultModelOption(
  selection: string | undefined,
  options: readonly ProviderDefaultModelOption[],
  catalog: ModelDefinition[],
): ProviderDefaultModelOption | undefined {
  if (!selection) return undefined
  const selected = findCatalogModel(selection, catalog)
  return options.find((option) => {
    if (option.model === selection) return true
    const optionModel = findCatalogModel(option.model, catalog)
    return Boolean(selected?.family && optionModel?.family === selected.family)
  })
}

export function ConfigureModelStep() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const queryClient = useQueryClient()
  const [showOther, setShowOther] = useState(false)

  const activeProvider = settings?.llmProvider ?? 'anthropic'
  const provider = settings?.llmProviderStatus?.find((candidate) => candidate.id === activeProvider)
  const options = provider?.defaultModelOptions ?? []
  const catalog = provider?.catalog ?? []
  // The provider default is the last-resort selection while settings load or
  // when no global model has been persisted. Platform declares Grok here.
  const agentModel = settings?.models?.agentModel ?? provider?.defaultModels?.agent
  const matchedOption = findDefaultModelOption(agentModel, options, catalog)
  const otherSelected = showOther || (Boolean(agentModel) && !matchedOption)

  const persistSelection = (model: string) => {
    if (model === agentModel) return
    // Optimistically reflect the choice in the settings cache so the card
    // updates instantly. The mutation's onSuccess invalidation refetches to
    // reconcile with the server; onError rolls back to the previous value.
    void queryClient.cancelQueries({ queryKey: ['settings'] }).then(() => {
      const previous = queryClient.getQueryData<GlobalSettingsResponse>(['settings'])
      if (previous) {
        queryClient.setQueryData<GlobalSettingsResponse>(['settings'], {
          ...previous,
          models: { ...previous.models, agentModel: model },
        })
      }
      updateSettings.mutate(
        { models: { agentModel: model } },
        {
          onError: () => {
            if (previous) queryClient.setQueryData(['settings'], previous)
          },
        },
      )
    })
  }

  const selectRecommended = (model: string) => {
    setShowOther(false)
    persistSelection(model)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-normal max-w-sm">Pick a default model for your agents</h2>
        <p className="text-sm text-muted-foreground mt-1">
          New conversations will start with this model by default, but you can always choose a different one from the model selector if needed.
        </p>
      </div>

      <div className="space-y-3" role="radiogroup" aria-label="Default model">
        {options.map((option) => {
          const isSelected = !showOther && matchedOption?.model === option.model
          return (
            <div
              key={option.model}
              className={`rounded-lg border text-left transition-colors ${
                isSelected ? 'border-primary bg-muted/50' : 'hover:border-muted-foreground/50'
              }`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                className="w-full flex items-start gap-3 p-3 text-left"
                onClick={() => selectRecommended(option.model)}
                data-testid={`wizard-model-${option.model}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.tag}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {option.description}
                    {option.subdescription && <><br />{option.subdescription}</>}
                  </p>
                </div>
                <RadioIndicator selected={isSelected} />
              </button>
            </div>
          )
        })}

        <div
          className={`rounded-lg border text-left transition-colors ${
            otherSelected ? 'border-primary bg-muted/50' : 'hover:border-muted-foreground/50'
          }`}
        >
          <button
            type="button"
            role="radio"
            aria-checked={otherSelected}
            className="w-full flex items-start gap-3 p-3 text-left"
            onClick={() => setShowOther(true)}
            data-testid="wizard-model-other"
          >
            <div className="flex-1 min-w-0">
              <span className="font-medium text-sm">Other</span>
              <p className="text-xs text-muted-foreground mt-1">
                Choose any model from this provider&apos;s full catalogue.
              </p>
            </div>
            <RadioIndicator selected={otherSelected} />
          </button>
          {otherSelected && (
            <div className="flex items-center justify-between gap-3 border-t px-3 py-3">
              <span className="text-xs text-muted-foreground">Model</span>
              <SettingsModelSelect
                model={agentModel}
                onModelChange={persistSelection}
                align="end"
              />
            </div>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Change this default at any time in the settings.
      </p>
    </div>
  )
}

function RadioIndicator({ selected }: { selected: boolean }) {
  return (
    <div className={`mt-1 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
      selected ? 'border-primary' : 'border-muted-foreground/40'
    }`}>
      {selected && <div className="h-2 w-2 rounded-full bg-primary" />}
    </div>
  )
}
