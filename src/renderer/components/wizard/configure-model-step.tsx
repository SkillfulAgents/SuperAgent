import { useSettings, useModelSettings, useUpdateSettings, type GlobalSettingsResponse } from '@renderer/hooks/use-settings'
import { useQueryClient } from '@tanstack/react-query'

/** Onboarding offers just the headline families; each stores a bare alias. */
type WizardFamily = 'grok' | 'opus' | 'sonnet'

const MODEL_OPTIONS: Array<{
  family: WizardFamily
  label: string
  tag: string
  description: string
  subdescription: string
}> = [
  {
    family: 'grok',
    label: 'Grok',
    tag: 'Best value',
    description: 'Best for everyday tasks and most agent work.',
    subdescription: 'The lowest credit cost of the three.',
  },
  {
    family: 'opus',
    label: 'Opus',
    tag: 'Most capable',
    description: 'Best for complex, multi-step tasks.',
    subdescription: 'Slower, and uses 5x more credits than Sonnet.',
  },
  {
    family: 'sonnet',
    label: 'Sonnet',
    tag: 'Fast & efficient',
    description: 'Best for everyday tasks and most agent work.',
    subdescription: 'Far lower credit cost than Opus.',
  },
]

export function ConfigureModelStep() {
  const { data: settings } = useSettings()
  const { data: modelSettings } = useModelSettings()
  const updateSettings = useUpdateSettings()
  const queryClient = useQueryClient()

  // Only offer families the active provider can actually serve. The copy below
  // promises new conversations start with the pick, and a Claude-only setup
  // (direct key, Bedrock, subscription) carries no Grok — offering it there
  // would promise a model the resolver silently swaps for the provider default.
  // An empty catalog means the provider is still loading or unconfigured, so
  // fall back to the full list rather than rendering an empty step.
  const activeProvider = modelSettings?.llmProvider ?? settings?.llmProvider
  const catalog = modelSettings?.llmProviderStatus?.find((p) => p.id === activeProvider)?.catalog ?? []
  const options = catalog.length
    ? MODEL_OPTIONS.filter((o) => catalog.some((m) => m.family === o.family))
    : MODEL_OPTIONS

  // The global "Default model" setting (LLM tab) persists `models.agentModel`
  // as a bare family alias or a pinned id. Derive the headline family from it so
  // onboarding and settings stay in sync. A stored model outside these families
  // (GPT, GLM, a custom id) leaves NOTHING selected rather than claiming one of
  // them — and every row stays clickable, so the pick always persists.
  const agentModel = settings?.models?.agentModel
  const selectedFamily = options.find((o) => agentModel?.includes(o.family))?.family

  const handleSelect = async (family: WizardFamily) => {
    // Guard on the STORED value, not the derived row: re-clicking a row that is
    // already the stored alias is a true no-op, while a stored model outside
    // these families still writes (that click is not redundant).
    if (agentModel === family) return
    // Optimistically reflect the choice in the settings cache so the card
    // updates instantly. The mutation's onSuccess invalidation refetches to
    // reconcile with the server; onError rolls back to the previous value.
    await queryClient.cancelQueries({ queryKey: ['settings'] })
    const previous = queryClient.getQueryData<GlobalSettingsResponse>(['settings'])
    if (previous) {
      queryClient.setQueryData<GlobalSettingsResponse>(['settings'], {
        ...previous,
        models: { ...previous.models, agentModel: family },
      })
    }
    updateSettings.mutate(
      { models: { agentModel: family } },
      {
        onError: () => {
          if (previous) queryClient.setQueryData(['settings'], previous)
        },
      },
    )
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
          const isSelected = selectedFamily === option.family
          return (
            <div
              key={option.family}
              className={`rounded-lg border text-left transition-colors ${
                isSelected ? 'border-primary bg-muted/50' : 'hover:border-muted-foreground/50'
              }`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                className="w-full flex items-start gap-3 p-3 text-left"
                onClick={() => handleSelect(option.family)}
                data-testid={`wizard-model-${option.family}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.tag}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {option.description}<br />{option.subdescription}
                  </p>
                </div>
                <div className={`mt-1 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  isSelected ? 'border-primary' : 'border-muted-foreground/40'
                }`}>
                  {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
                </div>
              </button>
            </div>
          )
        })}
      </div>

      <p className="text-sm text-muted-foreground">
        Change this default at any time in the settings.
      </p>
    </div>
  )
}
