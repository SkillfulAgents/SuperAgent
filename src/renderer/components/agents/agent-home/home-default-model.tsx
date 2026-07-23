import { RotateCcw } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { SettingsModelSelect } from '@renderer/components/settings/settings-model-select'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

interface HomeDefaultModelProps {
  agentSlug: string
  className?: string
}

/**
 * Slim card with the agent's default model + effort, stored in agent
 * preferences. Optional — when unset the picker displays the app-wide default,
 * and new sessions, crons, webhooks and chat integrations fall back to it. A
 * per-trigger or per-session pick still wins over both.
 */
export function HomeDefaultModel({ agentSlug, className }: HomeDefaultModelProps) {
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
      className={cn('flex items-center justify-between gap-2 rounded-xl border bg-background py-2 px-4', className)}
      data-testid="home-default-model-card"
    >
      <span className="text-sm font-medium text-muted-foreground">Default Model</span>
      <div className="flex min-w-0 items-center gap-1">
        {hasCustom ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-label="Reset to global default"
            title="Reset to global default"
            data-testid="home-default-model-reset"
            onClick={() => updatePreferences.mutate({ defaultModel: null, defaultEffort: null, defaultSpeed: null })}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground/70">Global</span>
        )}
        <SettingsModelSelect
          model={displayModel}
          onModelChange={(m) => updatePreferences.mutate({ defaultModel: m })}
          includeEffort
          effort={displayEffort as EffortLevel}
          onEffortChange={(e) => updatePreferences.mutate({ defaultEffort: e })}
          includeSpeed
          speed={displaySpeed as SpeedLevel}
          // 'normal' is the built-in default, not an override: store null (clear
          // the key, like reset does) so it never flips the Custom badge on —
          // including when useSpeedClamp auto-fires after a model switch.
          onSpeedChange={(s) => updatePreferences.mutate({ defaultSpeed: s === 'normal' ? null : s })}
          disabled={updatePreferences.isPending}
        />
      </div>
    </div>
  )
}
