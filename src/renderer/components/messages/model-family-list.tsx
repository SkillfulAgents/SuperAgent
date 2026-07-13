import { useMemo, useState, type ReactNode } from 'react'
import { Check, HelpCircle, Settings, TriangleAlert } from 'lucide-react'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
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

// Vendor tabs are keyed by the catalog entry's brand-icon key, same as the
// model rows' icons — the catalog has no separate vendor field.
const VENDOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zai: 'Z.AI',
  xai: 'xAI',
}

const NO_VENDOR = 'other'

/** Tab-grouping key for a model: its brand-icon key; uploaded or missing icons pool under "other". */
function vendorKey(m: ModelDefinition): string {
  if (!m.icon || m.icon.startsWith('uploaded:')) return NO_VENDOR
  return m.icon
}

/** Display name for a vendor tab key. */
export function vendorDisplayName(key: string): string {
  if (key === NO_VENDOR) return 'Other'
  return VENDOR_LABELS[key] ?? capitalize(key)
}

/**
 * Families whose entries are versions of one product line. These collapse to a
 * single row ("Opus") with per-version pin chips revealed on hover/selection.
 * Families outside this set (e.g. 'gpt', where each entry is a distinct tier)
 * keep one row per concrete model.
 */
const LINEAGE_FAMILIES = new Set(['fable', 'opus', 'sonnet', 'haiku'])

/** Chip label for a version: its label minus the family prefix ("Opus 4.8" → "4.8"). */
function versionChipLabel(label: string, familyName: string): string {
  if (label.toLowerCase().startsWith(familyName.toLowerCase())) {
    return label.slice(familyName.length).trim() || label
  }
  return label
}

/**
 * Base of a label's product line: the label minus a trailing variant word, when
 * what remains ends in a digit — "GPT-5.6 Sol" → "GPT-5.6", but "GPT-5.5" (no
 * variant word) and "Sonnet 4.6" ("Sonnet" doesn't end in a digit) stay whole.
 * Non-lineage models sharing a base collapse to one row with variant chips.
 */
function lineBase(label: string): string {
  const match = label.match(/^(.*\d)\s+\S+$/)
  return match ? match[1] : label
}

/** Partition models into label-derived lines, preserving order of first appearance. */
function splitIntoLines(models: ModelDefinition[]): { base: string; models: ModelDefinition[] }[] {
  const byBase = new Map<string, ModelDefinition[]>()
  for (const m of models) {
    const base = lineBase(m.label)
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base)!.push(m)
  }
  return [...byBase.entries()].map(([base, lineModels]) => ({ base, models: lineModels }))
}

/** Row-suffix slug for a line base: "GPT-5.6" → "gpt-5.6". */
function lineSlug(base: string): string {
  return base.toLowerCase().replace(/\s+/g, '-')
}

/**
 * Shared label prefix of a set of models, trimmed of trailing punctuation —
 * "GPT-5.4"/"GPT-5.5"/"GPT-5.6 Sol" → "GPT-5". For copy describing a
 * family-wide trait at the right generation grain; falls back when empty.
 */
function familyLabelPrefix(models: ModelDefinition[], fallback: string): string {
  const labels = models.map((m) => m.label)
  if (labels.length === 0) return fallback
  let prefix = labels[0]
  for (const label of labels.slice(1)) {
    while (prefix && !label.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  prefix = prefix.replace(/[^A-Za-z0-9]+$/, '')
  return prefix || fallback
}

/** Compact token-count label for warnings, e.g. 272000 → "272K", 1_050_000 → "1.05M". */
export function formatTokenThreshold(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(0)}K`
  return String(tokens)
}

/**
 * Warning copy for a model that can't do web tools, or null when they work (no banner). Native web
 * tools depend on the model's own support (Claude, and GPT over the Platform); a configured host vendor exposes the `mcp__web__*` tools to ANY model, so
 * they are "unavailable" only when the model lacks native support AND no vendor is set - the caller
 * passes that one boolean. INVARIANT: the single boolean assumes every registered vendor implements
 * BOTH operations (Exa does). The backend seam is per-tool (optional search?()/fetch?(), the MCP
 * gate, the container derivation), but the client only knows the vendor *id*, not its capabilities.
 * If a search-only or fetch-only vendor is ever added, re-split this into per-tool booleans and
 * plumb the vendor's capabilities to the client - else this banner would misreport the missing side.
 */
export function webToolsWarning(unavailable: boolean): string | null {
  if (!unavailable) return null
  return 'Web search and fetch aren’t available on this model. Set a provider under Settings → Web to use them on any model.'
}

type LongContextCliff = NonNullable<ModelDefinition['longContextPriceCliff']>

// Detail copy behind the cliff banner's info icon: the consequence in plain
// terms plus the one lever the user has (a fresh session). Frames the threshold
// as a share of the context window when known, else as a raw token count. The
// input multiplier stands in for the whole step — input tokens dominate cost in
// long conversations, which is why the cliff exists at all.
export function longContextWarningText(cliff: LongContextCliff, contextWindow?: number): string {
  const where = contextWindow
    ? `about ${Math.round((cliff.thresholdTokens / contextWindow) * 100)}% of the context window`
    : `~${formatTokenThreshold(cliff.thresholdTokens)} tokens of context`
  return `Beyond ${where}, requests cost roughly ${cliff.inputMultiplier}× as much. Starting a new session resets this.`
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
  /** One collapsed row with version pin chips vs one row per model. */
  lineage: boolean
}

interface ModelFamilyListProps {
  catalog: ModelDefinition[]
  /** Raw selection — a concrete id, or (when offerLatest) a bare family alias. */
  value: string | undefined
  /** Called with the value to store: a concrete id, or a bare alias for the "latest" row. */
  onPick: (value: string) => void
  /**
   * Section label (e.g. "Models") rendered INSIDE the picker, above the vendor
   * tabs — passed in by the parent so the label and tabs stack as one block.
   */
  header?: ReactNode
  /**
   * Offer a "· latest" row per family that stores the bare alias (rides upgrades).
   * ON for saved-setting selectors; OFF for the per-message composer, where
   * latest-vs-pinned has no meaning — you pick a concrete version to send now.
   */
  offerLatest?: boolean
  /**
   * Active host web-provider id from global settings. Native web search/fetch depend on the model
   * (the `supportsWebSearch` flag; Claude and GPT-over-Platform have them); a configured vendor
   * exposes the `mcp__web__*` tools to ANY model, so the
   * "not available" warning clears once a vendor is set. Undefined / 'native' = no host vendor.
   */
  webProvider?: string
}

function Row({
  label,
  isSelected,
  indent,
  onClick,
  testId,
}: {
  label: ReactNode
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
      <span className="min-w-0 truncate">{label}</span>
      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
    </button>
  )
}

/**
 * Collapsed row for a product line: the label picks the line's main value, and
 * per-model pin chips — revealed on hover, keyboard focus, or while selected —
 * pin a specific entry. Chips are siblings of the label button (buttons can't
 * nest); the spacer pushes the check to the row's right edge.
 *
 * Touch devices have no hover to reveal chips — worse, invisible chips would
 * still be tap targets, silently pinning a version the user never saw. So on
 * coarse pointers (`touch:` variant) the chips are display-none and the
 * selected row instead gains a gear that expands a nested menu below the row:
 * a "· latest" row (same action as the row label) plus one row per version.
 */
function LineRow({
  label,
  models,
  rowTestId,
  onRowPick,
  selected,
  activeId,
  chipLabel,
  onPickModel,
  latestSuffix,
}: {
  label: string
  models: ModelDefinition[]
  rowTestId: string
  onRowPick: () => void
  selected: boolean
  /** Concrete id whose chip renders highlighted (the pinned selection). */
  activeId?: string
  chipLabel: (m: ModelDefinition) => string
  onPickModel: (id: string) => void
  /** Append "· latest" to the label — set when the row click stores the bare
   *  alias (settings mode), so the alias-vs-pin semantics are visible. */
  latestSuffix?: boolean
}) {
  // Touch-only nested version menu, toggled by the gear on the selected row.
  // Rendered only while selected, so switching families auto-collapses it.
  const [versionsOpen, setVersionsOpen] = useState(false)
  // The row label picks the line's main value; a version row pins one. When no
  // listed version is the pinned selection, the "latest" row is the selected one.
  const pinnedVersionShown = models.some((m) => m.id === activeId)
  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-sm pr-2 hover:bg-accent',
          selected && 'bg-accent'
        )}
      >
        <button
          type="button"
          data-testid={rowTestId}
          onClick={onRowPick}
          className="flex min-w-0 items-center py-1 pl-2 text-left text-xs"
        >
          <span className="truncate">
            {label}
            {latestSuffix && <span className="text-muted-foreground"> · latest</span>}
          </span>
        </button>
        <span
          className={cn(
            'flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:hidden',
            selected && 'opacity-100'
          )}
        >
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              data-testid={`model-pinned-${m.id}`}
              aria-label={m.label}
              onClick={() => onPickModel(m.id)}
              className={cn(
                'rounded px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground hover:bg-background/80 hover:text-foreground',
                activeId === m.id && 'bg-background text-foreground shadow-sm'
              )}
            >
              {chipLabel(m)}
            </button>
          ))}
        </span>
        {/* The rest of the row is also a "pick the default" target, so clicking
            anywhere that isn't a version chip selects the latest. A plain div —
            the label button is the semantic click target. */}
        <div
          aria-hidden="true"
          data-testid={`${rowTestId}-fill`}
          onClick={onRowPick}
          className="h-6 min-w-0 flex-1 cursor-pointer"
        />
        {selected && (
          <button
            type="button"
            data-testid={`${rowTestId}-versions`}
            aria-label={`${label} versions`}
            aria-expanded={versionsOpen}
            onClick={() => setVersionsOpen((open) => !open)}
            className="hidden shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground touch:inline-flex"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {selected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
      </div>
      {selected && versionsOpen && (
        <div className="flex flex-col gap-0.5">
          <Row
            indent
            testId={`${rowTestId}-menu-latest`}
            label={<span>{label} <span className="text-muted-foreground">· latest</span></span>}
            isSelected={!pinnedVersionShown}
            onClick={onRowPick}
          />
          {models.map((m) => (
            <Row
              key={m.id}
              indent
              testId={`model-version-${m.id}`}
              label={m.label}
              isSelected={activeId === m.id}
              onClick={() => onPickModel(m.id)}
            />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Flat model picker shared by the saved-setting selector and the per-message
 * composer. A vendor tab bar (when the catalog spans more than one brand) filters
 * to one vendor. Lineage families (Opus, Sonnet, …) collapse to one row with
 * per-version pin chips revealed on hover/selection, and non-lineage models whose
 * labels share a versioned base ("GPT-5.6 Sol/Terra/Luna") collapse the same way;
 * remaining models render one row each, newest-first. When `offerLatest` is set, a
 * lineage row's label stores the bare alias (rides upgrades) and non-lineage
 * families gain a "· latest" alias row; otherwise labels pick the latest concrete
 * version. Keeps no popover state of its own — the parent owns open/close and
 * renders any effort section.
 */
export function ModelFamilyList({
  catalog,
  value,
  onPick,
  header,
  offerLatest = false,
  webProvider,
}: ModelFamilyListProps) {
  // Resolve the current selection (exact id, or a bare alias → its latest) for
  // highlighting and default vendor tab.
  const resolved = findCatalogModel(value, catalog)

  // Vendor tabs, in catalog order of first appearance. Until the user picks a
  // tab, follow the selection's vendor so opening the picker lands on the tab
  // that owns the highlighted model.
  const vendors = useMemo(() => {
    const seen: string[] = []
    for (const m of catalog) {
      const key = vendorKey(m)
      if (!seen.includes(key)) seen.push(key)
    }
    return seen
  }, [catalog])
  const [pickedVendor, setPickedVendor] = useState<string | null>(null)
  const activeVendor =
    (pickedVendor && vendors.includes(pickedVendor) ? pickedVendor : undefined) ??
    (resolved ? vendorKey(resolved) : undefined) ??
    vendors[0]

  const { families, standalone } = useMemo(() => {
    const order: string[] = []
    const byFamily = new Map<string, ModelDefinition[]>()
    const loose: ModelDefinition[] = []
    for (const m of catalog) {
      if (vendorKey(m) !== activeVendor) continue
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
      lineage: LINEAGE_FAMILIES.has(family),
    }))
    return { families: groups, standalone: loose }
  }, [catalog, activeVendor])
  const isLatestSelected = offerLatest && value !== undefined && families.some((g) => g.family === value)
  const selectedFamily = isLatestSelected ? value : resolved?.family

  // Native web tools depend on the model's own support (Claude, GPT-over-Platform); a configured host vendor makes them work on ANY model, so web
  // tools are unavailable only when the model lacks native support AND no vendor is set.
  // `native`/undefined means no host vendor.
  const nativeWebUnavailable = resolved?.supportsWebSearch === false
  const webVendorSet = !!webProvider && webProvider !== 'native'
  const webWarning = webToolsWarning(nativeWebUnavailable && !webVendorSet)

  return (
    <div className="flex flex-col gap-0.5">
      {(header !== undefined || vendors.length > 1) && (
        // One row: section label left, vendor tabs right. The tab bar is an
        // icon-only single-select segmented control, mirroring the Appearance
        // picker in general settings (intentionally not Radix Tabs — see that
        // comment). Names live in standard-delay tooltips so the bar scales to
        // many vendors without crowding.
        <div className="flex items-center justify-between gap-2 pb-1 pl-2 pr-1 pt-1">
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/70">
            {header}
          </span>
          {vendors.length > 1 && (
            <TooltipProvider>
              <div
                role="radiogroup"
                aria-label="Model vendor"
                className="inline-flex shrink-0 items-center rounded-lg bg-muted p-0.5 text-muted-foreground"
              >
                {vendors.map((key) => {
                  const isActive = key === activeVendor
                  return (
                    <Tooltip key={key}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          aria-label={vendorDisplayName(key)}
                          data-testid={`model-vendor-tab-${key}`}
                          onClick={() => setPickedVendor(key)}
                          className={cn(
                            'inline-flex h-6 w-8 items-center justify-center rounded-md transition-all hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isActive && 'bg-background text-foreground shadow'
                          )}
                        >
                          <ModelIcon icon={key === NO_VENDOR ? undefined : key} className="h-3.5 w-3.5 shrink-0" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{vendorDisplayName(key)}</TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </TooltipProvider>
          )}
        </div>
      )}
      {/* Like the cliff note below, scoped to the tab that owns the selection —
          on any other tab its "this model" copy would read as being about the
          listed models. */}
      {webWarning && resolved && vendorKey(resolved) === activeVendor && (
        <div
          data-testid="model-no-websearch-warning"
          className="mx-1 mb-1 flex items-start gap-1.5 rounded-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{webWarning}</span>
        </div>
      )}
      {families.map((group) => {
        const familyHasSelection = selectedFamily === group.family
        if (group.lineage) {
          const latestVersion = group.versions.find((v) => v.isLatest) ?? group.versions[0]
          return (
            <LineRow
              key={group.family}
              label={group.displayName}
              models={group.versions}
              rowTestId={offerLatest ? `model-latest-${group.family}` : `model-family-${group.family}`}
              // Bare alias in settings (rides upgrades); latest concrete id in
              // the composer (per-message picks are concrete).
              onRowPick={() => onPick(offerLatest ? group.family : latestVersion.id)}
              selected={familyHasSelection}
              activeId={!isLatestSelected ? resolved?.id : undefined}
              chipLabel={(m) => versionChipLabel(m.label, group.displayName)}
              onPickModel={onPick}
              latestSuffix={offerLatest}
            />
          )
        }
        return (
          <div key={group.family} className="flex flex-col gap-0.5">
            {offerLatest && (
              <Row
                testId={`model-latest-${group.family}`}
                label={<span>{group.displayName} <span className="text-muted-foreground">· latest</span></span>}
                isSelected={familyHasSelection && isLatestSelected}
                onClick={() => onPick(group.family)}
              />
            )}
            {splitIntoLines(group.versions).map((line) => {
              if (line.models.length > 1) {
                const lineLatest = line.models.find((m) => m.isLatest) ?? line.models[0]
                return (
                  <LineRow
                    key={line.base}
                    label={line.base}
                    models={line.models}
                    rowTestId={`model-family-${lineSlug(line.base)}`}
                    // No bare alias exists for a sub-line, so both modes pin
                    // the line's newest concrete id.
                    onRowPick={() => onPick(lineLatest.id)}
                    selected={!isLatestSelected && line.models.some((m) => m.id === resolved?.id)}
                    activeId={!isLatestSelected ? resolved?.id : undefined}
                    chipLabel={(m) => versionChipLabel(m.label, line.base)}
                    onPickModel={onPick}
                  />
                )
              }
              const version = line.models[0]
              return (
                <Row
                  key={version.id}
                  testId={`model-pinned-${version.id}`}
                  label={
                    offerLatest
                      ? <span>{version.label} <span className="text-muted-foreground">· pinned</span></span>
                      : version.label
                  }
                  isSelected={!isLatestSelected && resolved?.id === version.id}
                  onClick={() => onPick(version.id)}
                />
              )
            })}
          </div>
        )
      })}
      {standalone.map((m) => (
        <Row
          key={m.id}
          testId={`model-option-${m.id}`}
          label={m.label}
          isSelected={resolved?.id === m.id}
          onClick={() => onPick(m.id)}
        />
      ))}
      {/* End-of-list footnote — only on the tab that owns the selection, else
          it reads as being about the listed models. Blue text, no fill: it's
          informational, not the web-tools warning's amber alert. Hovering
          ANYWHERE on the line shows the explanation. */}
      {resolved?.longContextPriceCliff && vendorKey(resolved) === activeVendor && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="model-long-context-cliff-warning"
                // px-2 (no margin) lines the text up with the row labels above.
                // Same blues as the effort slider's accents (light/dark pair).
                className="mt-1 flex cursor-default items-center gap-1 rounded-sm px-2 py-1 text-left text-[11px] text-[#007DED] dark:text-[#4EB3FF]"
              >
                {/* The cliff is a family-wide trait (every GPT entry shares
                    it), so name the family's generation ("GPT-5 models")
                    rather than the picked version. */}
                <span className="min-w-0 flex-1 truncate">
                  Long chats cost more on{' '}
                  {resolved.family
                    ? `${familyLabelPrefix(
                        catalog.filter((m) => m.family === resolved.family),
                        familyDisplayName(resolved.family),
                      )} models`
                    : resolved.label}
                </span>
                <HelpCircle
                  data-testid="model-long-context-cliff-info"
                  className="h-3 w-3 shrink-0"
                  aria-hidden="true"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              {longContextWarningText(resolved.longContextPriceCliff, resolved.contextWindow)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
