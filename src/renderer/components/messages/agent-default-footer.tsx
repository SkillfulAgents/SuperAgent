import { Check, MoreHorizontal, Pin, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Separator } from '@renderer/components/ui/separator'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useUser } from '@renderer/context/user-context'
import type { ComposerOptionsState } from './composer-options'
import { familyDisplayName, findCatalogModel } from './model-family-list'
import { EFFORT_LABELS } from './effort-slider'
import { SPEED_LABELS } from './speed-section'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

interface AgentDefaultFooterProps {
  agentSlug: string
  state: ComposerOptionsState
}

/**
 * Footer for the composer model popover: always names the agent default (checked
 * when the session's pick matches it), with a menu to promote the pick into agent
 * preferences or clear them back to the global default. Renders its own leading
 * separator so a not-ready null return leaves no dangling rule.
 *
 * Only agent admins can write preferences (the PUT is AgentAdmin-gated), so
 * members get a read-only line naming the default instead of a button that
 * would 403.
 */
export function AgentDefaultFooter({ agentSlug, state }: AgentDefaultFooterProps) {
  const { data: settings } = useModelSettings()
  const { data: prefs, isFetched: prefsFetched } = useAgentPreferences(agentSlug)
  const updatePreferences = useUpdateAgentPreferences(agentSlug)
  const { canAdminAgent } = useUser()

  // The effective default this composer's untouched state would adopt:
  // agent preference → app-wide setting → built-in.
  const defaultModel = prefs?.defaultModel ?? settings?.models?.agentModel
  const defaultEffort = (prefs?.defaultEffort ?? settings?.models?.agentEffort ?? 'medium') as EffortLevel
  const defaultSpeed = (prefs?.defaultSpeed ?? 'normal') as SpeedLevel

  // Compare through catalog resolution: the composer stores concrete ids while
  // defaults are usually bare family aliases, so a raw string compare would
  // call the latest Opus an "override" of default 'opus'.
  const resolvedCurrent = findCatalogModel(state.model, state.catalog)
  const resolvedDefault = findCatalogModel(defaultModel, state.catalog)
  const modelDiffers = (resolvedCurrent?.id ?? state.model) !== (resolvedDefault?.id ?? defaultModel)
  const differs = modelDiffers || state.effort !== defaultEffort || state.speed !== defaultSpeed

  // Wait for both default sources — a footer computed off a half-loaded
  // default would flash the wrong state.
  if (!settings || !prefsFetched || !state.model) return null

  const promote = () => {
    updatePreferences.mutate(
      {
        // Store what the settings picker itself would: the family alias when
        // the pick is that family's latest (rides upgrades), the concrete id
        // only for a genuinely pinned older version.
        defaultModel: resolvedCurrent?.isLatest ? resolvedCurrent.family : state.model,
        defaultEffort: state.effort,
        // 'normal' is the built-in default, not an override — store null so it
        // never counts as a custom default (same rule as the home card).
        defaultSpeed: state.speed === 'normal' ? null : state.speed,
      },
      { onError: () => toast.error("Couldn't update the agent default") },
    )
  }

  const hasCustom = Boolean(prefs?.defaultModel || prefs?.defaultEffort || prefs?.defaultSpeed)
  const resetToGlobal = () => {
    state.applyGlobalDefault?.()
    if (!hasCustom) return
    updatePreferences.mutate(
      { defaultModel: null, defaultLlmProviderId: null, defaultEffort: null, defaultSpeed: null },
      { onError: () => toast.error("Couldn't reset the agent default") },
    )
  }

  const defaultIsAlias = defaultModel !== undefined && state.catalog.some((m) => m.family === defaultModel)
  const defaultModelLabel = defaultIsAlias ? familyDisplayName(defaultModel) : resolvedDefault?.label ?? defaultModel
  const speedSuffix =
    defaultSpeed !== 'normal' && SPEED_LABELS[defaultSpeed] ? ` · ${SPEED_LABELS[defaultSpeed]}` : ''
  const defaultLabel = defaultModelLabel ? `${defaultModelLabel} · ${EFFORT_LABELS[defaultEffort]}${speedSuffix}` : ''

  if (!defaultLabel) return null

  if (!canAdminAgent(agentSlug)) {
    // Members still learn the default exists and what it is.
    return (
      <>
        <Separator className="my-2 bg-border/50" />
        <div className="truncate px-2 py-1 text-xs text-muted-foreground" data-testid="composer-agent-default-readonly">
          Agent default: {defaultLabel}
        </div>
      </>
    )
  }

  return (
    <>
      <Separator className="my-2 bg-border/50" />
      {/* Same header treatment as the Effort / Speed sections above. */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] font-medium text-muted-foreground/70">
        <span
          data-testid="composer-agent-default-current"
          title={`Agent Default · ${defaultLabel}`}
          className="flex min-w-0 items-center gap-1"
        >
          {!differs && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
          <span className="truncate">
            <span>Agent Default</span>
            <span className="text-[#007DED] dark:text-[#4EB3FF]"> · {defaultLabel}</span>
          </span>
        </span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="composer-agent-default-menu"
              aria-label="Agent default options"
              title="Agent default options"
              className="inline-flex shrink-0 hover:text-foreground"
            >
              <MoreHorizontal className="h-3 w-3" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-0">
            <DropdownMenuItem
              data-testid="composer-agent-default"
              className="gap-1.5 py-1 text-xs [&>svg]:size-3.5"
              disabled={!differs || updatePreferences.isPending}
              onSelect={promote}
            >
              <Pin aria-hidden="true" />
              Set as Current Default
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="composer-agent-default-reset"
              className="gap-1.5 py-1 text-xs [&>svg]:size-3.5"
              // With no custom agent default, the agent default is the global one,
              // so there is still something to do while the pick diverges from it.
              disabled={(!hasCustom && !differs) || updatePreferences.isPending}
              onSelect={resetToGlobal}
            >
              <RotateCcw aria-hidden="true" />
              Use Global Default
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}
