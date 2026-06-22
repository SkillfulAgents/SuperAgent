import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { cn } from '@shared/lib/utils'
import type { ModelDefinition } from '@shared/lib/llm-provider'

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Acronym families that shouldn't be title-cased (e.g. 'gpt' → 'GPT', not 'Gpt').
const FAMILY_LABELS: Record<string, string> = { gpt: 'GPT', glm: 'GLM' }

/** Display name for a family key, special-casing acronyms. */
export function familyDisplayName(family: string): string {
  return FAMILY_LABELS[family] ?? capitalize(family)
}

/** Compact token-count label for warnings, e.g. 272000 → "272K", 1_050_000 → "1.05M". */
export function formatTokenThreshold(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(0)}K`
  return String(tokens)
}

type LongContextCliff = NonNullable<ModelDefinition['longContextPriceCliff']>

// Picker copy for a model's long-context price step; frames the threshold as a
// share of the context window when known, else as a raw token count.
export function longContextWarningText(cliff: LongContextCliff, contextWindow?: number): string {
  const where = contextWindow
    ? `beyond about ${Math.round((cliff.thresholdTokens / contextWindow) * 100)}% of the context window`
    : `beyond ~${formatTokenThreshold(cliff.thresholdTokens)} tokens of context`
  return `Note: ${where}, input pricing rises ${cliff.inputMultiplier}× and output ${cliff.outputMultiplier}×.`
}

/**
 * Resolve a stored selection to its catalog entry for display: an exact
 * concrete-id match first, then a bare family alias → that family's latest.
 * Mirrors the host resolver so the UI highlights the row that will go on the
 * wire. Lives here (not in composer-options) so the picker has no import cycle.
 */
export function findCatalogModel(
  selection: string | undefined,
  catalog: ModelDefinition[],
): ModelDefinition | undefined {
  if (!selection) return undefined
  return (
    catalog.find((m) => m.id === selection) ??
    catalog.find((m) => m.family === selection && m.isLatest)
  )
}

interface FamilyGroup {
  family: string
  displayName: string
  versions: ModelDefinition[]
}

interface ModelFamilyListProps {
  catalog: ModelDefinition[]
  /** Raw selection — a concrete id, or (when offerLatest) a bare family alias. */
  value: string | undefined
  /** Called with the value to store: a concrete id, or a bare alias for the "latest" row. */
  onPick: (value: string) => void
  /**
   * Offer a "· latest" row per family that stores the bare alias (rides upgrades).
   * ON for saved-setting selectors; OFF for the per-message composer, where
   * latest-vs-pinned has no meaning — you pick a concrete version to send now.
   */
  offerLatest?: boolean
  /**
   * When set, clicking a family header also selects that family's latest concrete
   * version (without closing) and expands it — one click gets the latest, the rest
   * stay visible for refinement. Used by the composer (the common "just give me the
   * latest" case); omitted by the settings picker, where the family is just a toggle.
   */
  onSelectFamilyLatest?: (value: string) => void
}

function Row({
  label,
  icon,
  isSelected,
  indent,
  onClick,
  testId,
}: {
  label: ReactNode
  icon?: ReactNode
  isSelected: boolean
  indent?: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
        indent && 'pl-7',
        isSelected && 'bg-accent'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
    </button>
  )
}

/**
 * Grouped model picker shared by the saved-setting selector and the per-message
 * composer. Layer 1 lists each family (and any family-less models); picking a
 * family expands it to its versions. When `offerLatest` is set, each family also
 * gets a "· latest" row that stores the bare alias; otherwise only concrete
 * versions are selectable. Keeps no popover state of its own — the parent owns
 * open/close and renders any effort section.
 */
export function ModelFamilyList({
  catalog,
  value,
  onPick,
  offerLatest = false,
  onSelectFamilyLatest,
}: ModelFamilyListProps) {
  const { families, standalone } = useMemo(() => {
    const order: string[] = []
    const byFamily = new Map<string, ModelDefinition[]>()
    const loose: ModelDefinition[] = []
    for (const m of catalog) {
      if (!m.family) {
        loose.push(m)
        continue
      }
      if (!byFamily.has(m.family)) {
        byFamily.set(m.family, [])
        order.push(m.family)
      }
      byFamily.get(m.family)!.push(m)
    }
    const groups: FamilyGroup[] = order.map((family) => ({
      family,
      displayName: familyDisplayName(family),
      // Catalogs are authored oldest→newest; show versions newest-first.
      versions: [...byFamily.get(family)!].reverse(),
    }))
    return { families: groups, standalone: loose }
  }, [catalog])

  // Resolve the current selection (exact id, or a bare alias → its latest) for
  // highlighting + auto-expand.
  const resolved = findCatalogModel(value, catalog)
  const isLatestSelected = offerLatest && value !== undefined && families.some((g) => g.family === value)
  const selectedFamily = isLatestSelected ? value : resolved?.family

  // Auto-expand the selected family; let the user toggle from there.
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined)
  const openFamily = expanded === undefined ? selectedFamily : expanded

  return (
    <div className="flex flex-col gap-0.5">
      {resolved?.supportsWebSearch === false && (
        <div
          data-testid="model-no-websearch-warning"
          className="mx-1 mb-1 flex items-start gap-1.5 rounded-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Web search and fetch aren’t available on this model.</span>
        </div>
      )}
      {resolved?.longContextPriceCliff && (
        <div
          data-testid="model-long-context-cliff-warning"
          className="mx-1 mb-1 flex items-start gap-1.5 rounded-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{longContextWarningText(resolved.longContextPriceCliff, resolved.contextWindow)}</span>
        </div>
      )}
      {families.map((group) => {
        const isOpen = openFamily === group.family
        const familyHasSelection = selectedFamily === group.family
        const latestVersion = group.versions.find((v) => v.isLatest) ?? group.versions[0]
        return (
          <div key={group.family} className="flex flex-col gap-0.5">
            <button
              type="button"
              data-testid={`model-family-${group.family}`}
              onClick={() => {
                if (onSelectFamilyLatest && latestVersion) {
                  // One-click latest: expand and select the family's newest
                  // version without closing, so refinement stays one tap away.
                  setExpanded(group.family)
                  onSelectFamilyLatest(latestVersion.id)
                } else {
                  setExpanded(isOpen ? null : group.family)
                }
              }}
              className={cn(
                'flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
                familyHasSelection && !isOpen && 'bg-accent/60'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ModelIcon icon={latestVersion?.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{group.displayName}</span>
              </span>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
            {isOpen && (
              <div className="flex flex-col gap-0.5 pb-1">
                {offerLatest && (
                  <Row
                    indent
                    testId={`model-latest-${group.family}`}
                    label={<span>{group.displayName} <span className="text-muted-foreground">· latest</span></span>}
                    isSelected={familyHasSelection && isLatestSelected}
                    onClick={() => onPick(group.family)}
                  />
                )}
                {group.versions.map((version) => (
                  <Row
                    key={version.id}
                    indent
                    testId={`model-pinned-${version.id}`}
                    label={
                      offerLatest
                        ? <span>{version.label} <span className="text-muted-foreground">· pinned</span></span>
                        : version.label
                    }
                    isSelected={!isLatestSelected && resolved?.id === version.id}
                    onClick={() => onPick(version.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
      {standalone.map((m) => (
        <Row
          key={m.id}
          testId={`model-option-${m.id}`}
          icon={<ModelIcon icon={m.icon} className="h-3.5 w-3.5 shrink-0" />}
          label={m.label}
          isSelected={resolved?.id === m.id}
          onClick={() => onPick(m.id)}
        />
      ))}
    </div>
  )
}
