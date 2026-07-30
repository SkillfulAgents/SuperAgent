import { Check, Pin, Settings } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Separator } from '@renderer/components/ui/separator'
import { useModelSettings } from '@renderer/hooks/use-settings'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useUser } from '@renderer/context/user-context'
import { findCatalogModel, type ComposerOptionsState } from './composer-options'
import { familyDisplayName } from './model-family-list'
import { EFFORT_LABELS } from './effort-slider'
import { SPEED_LABELS } from './speed-section'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

interface AgentDefaultFooterProps {
  agentSlug: string
  state: ComposerOptionsState
  /**
   * Show the gear link to the agent home page, where the Agent Default Model
   * card lives. Off for the agent-home composer itself — the card is already
   * on screen there, and a link to the current page reads as a dead button.
   */
  agentHomeLink?: boolean
}

/**
 * Footer for the composer model popover: the per-session counterpart of the
 * settings picker's "Reset to Global Default" row, one level down the
 * hierarchy. Where that row compares an agent default against the app-wide
 * default, this one compares the session's pick against the agent default —
 * "Set as Agent Default" promotes the current model/effort/speed into agent
 * preferences so future sessions start there. Renders its own leading
 * separator so a not-ready null return leaves no dangling rule.
 *
 * Only agent admins can write preferences (the PUT is AgentAdmin-gated), so
 * members get a read-only line naming the default instead of a button that
 * would 403.
 */
export function AgentDefaultFooter({ agentSlug, state, agentHomeLink = true }: AgentDefaultFooterProps) {
  const { data: settings } = useModelSettings()
  const { data: prefs, isFetched: prefsFetched } = useAgentPreferences(agentSlug)
  const updatePreferences = useUpdateAgentPreferences(agentSlug)
  const { canAdminAgent } = useUser()
  const navigate = useNavigate()

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

  if (!canAdminAgent(agentSlug)) {
    // Members still learn the default exists and what it is.
    const defaultIsAlias = defaultModel !== undefined && state.catalog.some((m) => m.family === defaultModel)
    const defaultLabel = defaultIsAlias
      ? familyDisplayName(defaultModel)
      : resolvedDefault?.label ?? defaultModel
    if (!defaultLabel) return null
    const speedSuffix =
      defaultSpeed !== 'normal' && SPEED_LABELS[defaultSpeed as SpeedLevel]
        ? ` · ${SPEED_LABELS[defaultSpeed as SpeedLevel]}`
        : ''
    return (
      <>
        <Separator className="my-2 bg-border/50" />
        <div className="truncate px-2 py-1 text-xs text-muted-foreground" data-testid="composer-agent-default-readonly">
          Agent default: {defaultLabel} · {EFFORT_LABELS[defaultEffort]}{speedSuffix}
        </div>
      </>
    )
  }

  return (
    <>
      <Separator className="my-2 bg-border/50" />
      <div className="flex items-center justify-between gap-2">
        {/* The action is only offered when it would do something; a matching
            pick states the status instead — which also serves as the
            confirmation right after promoting. */}
        {differs ? (
          <button
            type="button"
            data-testid="composer-agent-default"
            disabled={updatePreferences.isPending}
            onClick={promote}
            className="flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50"
          >
            <Pin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Set as Agent Default</span>
          </button>
        ) : (
          <div
            data-testid="composer-agent-default-current"
            className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground"
          >
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Current Agent Default</span>
          </div>
        )}
        {agentHomeLink && (
          <button
            type="button"
            data-testid="composer-agent-default-change"
            aria-label="Change agent default in Agent Home"
            title="Change agent default in Agent Home"
            onClick={() => void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })}
            className="shrink-0 rounded-sm p-1 text-muted-foreground/70 hover:text-foreground"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </>
  )
}
