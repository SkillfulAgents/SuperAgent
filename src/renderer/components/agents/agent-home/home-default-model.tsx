import { useModelSettings } from '@renderer/hooks/use-settings'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

interface HomeDefaultModelProps {
  agentSlug: string
}

/**
 * Row with the agent's default model + effort, stored in agent preferences.
 * Rendered as the first line item of the HomeExtras card. Optional — when
 * unset the picker displays the app-wide default, and new sessions, crons,
 * webhooks and chat integrations fall back to it. A per-trigger or
 * per-session pick still wins over both. The picker's footer reverts to
 * following the app-wide default.
 */
export function HomeDefaultModel({ agentSlug }: HomeDefaultModelProps) {
  // Picker-safe endpoint — the card renders for every agent member, admin or not.
  const { data: settings } = useModelSettings()
  const { data: prefs } = useAgentPreferences(agentSlug)
  const updatePreferences = useUpdateAgentPreferences(agentSlug)

  const hasCustom = Boolean(prefs?.defaultModel || prefs?.defaultEffort || prefs?.defaultSpeed)
  const displayModel = prefs?.defaultModel ?? settings?.models?.agentModel
  const displayEffort = prefs?.defaultEffort ?? settings?.models?.agentEffort ?? 'medium'
  const displaySpeed = prefs?.defaultSpeed ?? 'normal'

  return (
    <div
      className="flex items-center justify-between gap-2 py-2 px-4"
      data-testid="home-default-model-card"
    >
      <span className="text-sm font-medium text-muted-foreground">Agent Default Model</span>
      <SettingsModelSelect
        model={displayModel}
        onModelChange={(m) => updatePreferences.mutate({ defaultModel: m })}
        includeEffort
        effort={displayEffort as EffortLevel}
        onEffortChange={(e) => updatePreferences.mutate({ defaultEffort: e })}
        includeSpeed
        speed={displaySpeed as SpeedLevel}
        // 'normal' is the built-in default, not an override: store null (clear
        // the key, like reverting does) so it never counts as a custom default —
        // including when useSpeedClamp auto-fires after a model switch.
        onSpeedChange={(s) => updatePreferences.mutate({ defaultSpeed: s === 'normal' ? null : s })}
        disabled={updatePreferences.isPending}
        appDefault={{
          isOverride: hasCustom,
          onUseAppDefault: () =>
            updatePreferences.mutate({ defaultModel: null, defaultEffort: null, defaultSpeed: null }),
        }}
      />
    </div>
  )
}
