import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { ModelIcon } from '@renderer/components/ui/model-icon'
import { cn } from '@shared/lib/utils'
import { EFFORT_LEVELS, type EffortLevel } from '@shared/lib/container/types'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import {
  familyDisplayName,
  findCatalogModel,
  longContextWarningText,
  webToolsWarning,
} from './model-family-list'

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Level-1 groups are vendors, keyed by the catalog entry's brand-icon key.
const VENDOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  zai: 'Z.AI',
  xai: 'xAI',
}

const NO_VENDOR = 'other'

function vendorDisplayName(key: string): string {
  if (key === NO_VENDOR) return 'Other'
  return VENDOR_LABELS[key] ?? capitalize(key)
}

/**
 * Families rendered as a single matrix row (the latest version, with a "latest ›"
 * chip to pin an older one). Families outside this set — e.g. 'gpt', where each
 * entry is a distinct tier rather than an older version of the same line — get
 * one row per concrete model instead.
 */
const LINEAGE_FAMILIES = new Set(['fable', 'opus', 'sonnet', 'haiku'])

const COLUMN_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/** Colour ramp for the slider pill / knob / labels, keyed by effort. */
export const EFFORT_STYLE: Record<
  EffortLevel,
  { pill: string; label: string; dot: string }
> = {
  low: {
    pill: 'bg-emerald-400/85 dark:bg-emerald-400/75',
    label: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-400',
  },
  medium: {
    pill: 'bg-sky-400/85 dark:bg-sky-400/75',
    label: 'text-sky-600 dark:text-sky-400',
    dot: 'bg-sky-400',
  },
  high: {
    pill: 'bg-amber-400/85 dark:bg-amber-400/75',
    label: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-400',
  },
  xhigh: {
    pill: 'bg-orange-400/85 dark:bg-orange-400/75',
    label: 'text-orange-600 dark:text-orange-500',
    dot: 'bg-orange-400',
  },
  max: {
    pill: 'bg-violet-400/85 dark:bg-violet-400/75',
    label: 'text-violet-600 dark:text-violet-400',
    dot: 'bg-violet-400',
  },
}

// Matrix geometry (px). Cells are fixed-width so the pill can be positioned
// with plain arithmetic and animate via a width transition.
const LABEL_W = 112
const CELL_W = 46
const ROW_H = 32
const PILL_H = 28

interface MatrixRowDef {
  key: string
  label: string
  /** Set for lineage rows: the family whose versions the pin menu lists. */
  family?: string
  /** Versions newest-first (single entry for non-lineage rows). */
  versions: ModelDefinition[]
  /** What a cell click selects when nothing in this row is pinned. */
  latest: ModelDefinition
}

interface VendorGroup {
  key: string
  label: string
  icon?: string
  rows: MatrixRowDef[]
}

interface ModelEffortMatrixProps {
  catalog: ModelDefinition[]
  /** Raw selection — a concrete id or a bare family alias. */
  model: string | undefined
  effort: EffortLevel
  /** A cell (or pin) was picked. Effort is already clamped to the model's support. */
  onPick: (modelId: string, effort: EffortLevel) => void
  /** Active host web-provider id from global settings (see ModelFamilyList). */
  webProvider?: string
}

/**
 * Experimental combined model × effort picker. Level 1 lists vendors
 * (Anthropic, OpenAI, …); expanding one shows a matrix of model rows against
 * effort columns. The selected row renders a colour-coded slider pill from Low
 * up to the chosen effort. Lineage families collapse to one row with a
 * "latest ›" chip that opens a version-pin menu.
 */
export function ModelEffortMatrix({
  catalog,
  model,
  effort,
  onPick,
  webProvider,
}: ModelEffortMatrixProps) {
  const vendors = useMemo<VendorGroup[]>(() => {
    const order: string[] = []
    const byVendor = new Map<string, ModelDefinition[]>()
    for (const m of catalog) {
      const v = m.icon ?? NO_VENDOR
      if (!byVendor.has(v)) {
        byVendor.set(v, [])
        order.push(v)
      }
      byVendor.get(v)!.push(m)
    }
    return order.map((key) => {
      // Catalogs are authored oldest→newest; rows read best-first.
      const models = [...byVendor.get(key)!].reverse()
      const rows: MatrixRowDef[] = []
      const seenFamilies = new Set<string>()
      for (const m of models) {
        if (m.family && LINEAGE_FAMILIES.has(m.family)) {
          if (seenFamilies.has(m.family)) continue
          seenFamilies.add(m.family)
          const versions = models.filter((x) => x.family === m.family)
          rows.push({
            key: `family:${m.family}`,
            label: familyDisplayName(m.family),
            family: m.family,
            versions,
            latest: versions.find((v) => v.isLatest) ?? versions[0],
          })
        } else {
          rows.push({ key: m.id, label: m.label, versions: [m], latest: m })
        }
      }
      return {
        key,
        label: vendorDisplayName(key),
        icon: key === NO_VENDOR ? undefined : key,
        rows,
      }
    })
  }, [catalog])

  const resolved = findCatalogModel(model, catalog)

  // Auto-expand the vendor holding the current selection; user toggles from there.
  const [expanded, setExpanded] = useState<string | null | undefined>(undefined)
  const selectedVendor = resolved ? (resolved.icon ?? NO_VENDOR) : undefined
  const openVendor = expanded === undefined ? selectedVendor ?? vendors[0]?.key : expanded

  // One pin menu at a time, keyed by row key.
  const [pinOpenFor, setPinOpenFor] = useState<string | null>(null)

  // Slider-style drag: pointerdown on a cell starts, pointerenter while down
  // re-picks, window pointerup ends. Mouse/pen only — touch keeps plain taps.
  const dragging = useRef(false)
  useEffect(() => {
    const end = () => {
      dragging.current = false
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])

  // Pick a cell, clamping to the highest supported effort at or below the
  // requested column (so dragging along a low/med/high row stops at High).
  const pick = (m: ModelDefinition, level: EffortLevel) => {
    const wanted = EFFORT_LEVELS.indexOf(level)
    let clamped = m.supportedEfforts[0]
    for (const l of m.supportedEfforts) {
      if (EFFORT_LEVELS.indexOf(l) <= wanted) clamped = l
    }
    onPick(m.id, clamped)
  }

  const nativeWebUnavailable = resolved?.supportsWebSearch === false
  const webVendorSet = !!webProvider && webProvider !== 'native'
  const webWarning = webToolsWarning(nativeWebUnavailable && !webVendorSet)

  return (
    <div className="flex flex-col gap-0.5">
      {vendors.map((vendor) => {
        const isOpen = openVendor === vendor.key
        const holdsSelection = selectedVendor === vendor.key
        return (
          <div key={vendor.key} className="flex flex-col gap-0.5">
            <button
              type="button"
              data-testid={`matrix-vendor-${vendor.key}`}
              onClick={() => setExpanded(isOpen ? null : vendor.key)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
                holdsSelection && !isOpen && 'bg-accent/60'
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ModelIcon icon={vendor.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{vendor.label}</span>
              </span>
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
            {isOpen && (
              <div className="pb-1 pl-1">
                {/* Column headers, aligned to the cell grid. */}
                <div className="flex items-center">
                  <div style={{ width: LABEL_W }} className="shrink-0" />
                  {EFFORT_LEVELS.map((level) => (
                    <div
                      key={level}
                      style={{ width: CELL_W }}
                      className={cn(
                        'shrink-0 text-center text-[10px] font-medium',
                        effort === level && resolved && selectedVendor === vendor.key
                          ? EFFORT_STYLE[level].label
                          : 'text-muted-foreground'
                      )}
                    >
                      {COLUMN_LABELS[level]}
                    </div>
                  ))}
                </div>
                {vendor.rows.map((row) => {
                  // A pinned older version takes over the row (label chip + what cells select).
                  const pinned =
                    row.family && resolved?.family === row.family && !resolved.isLatest
                      ? resolved
                      : undefined
                  const active = pinned ?? row.latest
                  const isSelectedRow = resolved?.id === active.id && selectedVendor === vendor.key
                  const selIdx = EFFORT_LEVELS.indexOf(effort)
                  const pinOpen = pinOpenFor === row.key
                  const chip = row.family
                    ? pinned
                      ? pinned.label.replace(row.label, '').trim() || pinned.label
                      : 'latest'
                    : undefined
                  return (
                    <div key={row.key} className="flex flex-col">
                      <div className="flex items-center" style={{ height: ROW_H }}>
                        <div
                          style={{ width: LABEL_W }}
                          className="flex min-w-0 shrink-0 items-center gap-1 pl-1"
                        >
                          <button
                            type="button"
                            data-testid={`matrix-row-${row.key}`}
                            onClick={() => pick(active, effort)}
                            className={cn(
                              'truncate text-left text-xs hover:opacity-80',
                              isSelectedRow ? cn('font-medium', EFFORT_STYLE[effort].label) : 'text-foreground'
                            )}
                          >
                            {row.label}
                          </button>
                          {chip && (
                            <button
                              type="button"
                              data-testid={`matrix-pin-toggle-${row.key}`}
                              onClick={() => setPinOpenFor(pinOpen ? null : row.key)}
                              className="flex shrink-0 items-center text-[10px] text-muted-foreground hover:text-foreground"
                              aria-label={`Pin a ${row.label} version`}
                            >
                              {chip}
                              <ChevronRight
                                className={cn('h-2.5 w-2.5 transition-transform', pinOpen && 'rotate-90')}
                              />
                            </button>
                          )}
                        </div>
                        <div
                          className="relative grid shrink-0 touch-none select-none"
                          style={{ gridTemplateColumns: `repeat(${EFFORT_LEVELS.length}, ${CELL_W}px)` }}
                        >
                          {/* Slider pill from Low to the selected effort. */}
                          {isSelectedRow && (
                            <div
                              data-testid="matrix-pill"
                              className={cn(
                                'pointer-events-none absolute z-10 flex items-center justify-end rounded-full pr-[4px] transition-all duration-300 ease-out',
                                EFFORT_STYLE[effort].pill
                              )}
                              style={{
                                left: 2,
                                top: (ROW_H - PILL_H) / 2,
                                height: PILL_H,
                                width: (selIdx + 1) * CELL_W - 4,
                              }}
                            >
                              <div className="h-5 w-5 rounded-full bg-white shadow-md ring-1 ring-black/10" />
                            </div>
                          )}
                          {EFFORT_LEVELS.map((level) => {
                            const supported = active.supportedEfforts.includes(level)
                            return (
                              <button
                                key={level}
                                type="button"
                                data-testid={`matrix-cell-${row.key}-${level}`}
                                aria-label={`${row.label} · ${COLUMN_LABELS[level]}`}
                                aria-disabled={!supported}
                                onPointerDown={
                                  supported
                                    ? (e) => {
                                        e.preventDefault()
                                        dragging.current = true
                                        pick(active, level)
                                      }
                                    : undefined
                                }
                                onPointerEnter={(e) => {
                                  // Drag across the grid: unsupported cells clamp
                                  // down inside pick(), so the knob stops at the
                                  // row's highest supported effort. Require the
                                  // primary button to actually be held so a
                                  // layout-driven enter can't re-pick.
                                  if (dragging.current && e.buttons === 1) pick(active, level)
                                }}
                                className={cn(
                                  'flex items-center justify-center rounded-md',
                                  supported ? 'cursor-pointer hover:bg-accent/70' : 'cursor-default'
                                )}
                                style={{ height: ROW_H }}
                              >
                                <span
                                  className={cn(
                                    'h-[5px] w-[5px] rounded-full',
                                    supported ? 'bg-muted-foreground/40' : 'bg-muted-foreground/15'
                                  )}
                                />
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      {pinOpen && row.family && (
                        <div className="flex flex-col gap-0.5 pb-1 pl-6">
                          {row.versions.map((version) => {
                            const isPick = active.id === version.id
                            return (
                              <button
                                key={version.id}
                                type="button"
                                data-testid={`matrix-pin-${version.id}`}
                                onClick={() => {
                                  pick(version, effort)
                                  setPinOpenFor(null)
                                }}
                                className={cn(
                                  'flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
                                  isPick && 'bg-accent'
                                )}
                              >
                                <span>
                                  {version.label}
                                  {version.isLatest && (
                                    <span className="text-muted-foreground"> · latest</span>
                                  )}
                                </span>
                                {isPick && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {/* Warnings render BELOW the matrix: inserting them above would shift the
          rows mid-press and a layout-driven pointerenter could re-pick the
          wrong cell (seen live when picking a GPT model summoned the
          long-context banner). */}
      {webWarning && (
        <div
          data-testid="model-no-websearch-warning"
          className="mx-1 mt-1 flex items-start gap-1.5 rounded-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{webWarning}</span>
        </div>
      )}
      {resolved?.longContextPriceCliff && (
        <div
          data-testid="model-long-context-cliff-warning"
          className="mx-1 mt-1 flex items-start gap-1.5 rounded-sm bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{longContextWarningText(resolved.longContextPriceCliff, resolved.contextWindow)}</span>
        </div>
      )}
    </div>
  )
}
