import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, Search, AlertCircle, ChevronRight, ListFilter, Undo2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { SCOPE_MAPS } from '@shared/lib/proxy/scope-maps'
import { getScopeDescription, getScopeLabel, type ScopeLabel } from '@shared/lib/proxy/scope-metadata'
import {
  isLabelDefaultKey,
  labelDefaultKey,
  LABEL_DEFAULT_BASELINE,
} from '@shared/lib/proxy/policy-sentinels'
import {
  PolicyDecisionToggle,
  PolicyDecisionDropdown,
  PolicyDecisionIcon,
} from '@renderer/components/ui/policy-decision-toggle'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { cn } from '@shared/lib/utils/cn'

type PolicyDecision = 'allow' | 'review' | 'block' | 'default'

interface ScopePolicy {
  scope: string
  decision: PolicyDecision
}

const LABEL_GROUPS: Array<{
  key: ScopeLabel
  title: string
}> = [
  { key: 'read', title: 'Read actions' },
  { key: 'write', title: 'Write/Delete actions' },
  { key: 'destructive', title: 'Destructive actions' },
]

const emptyLabelDefaults: Record<ScopeLabel, PolicyDecision> = {
  read: 'default',
  write: 'default',
  destructive: 'default',
}

/**
 * Stable string form of the non-default policy entries, used to detect whether
 * the editor has unsaved changes. Defaults are dropped (they're never written)
 * and entries are sorted so order doesn't affect the comparison.
 */
function serializePolicies(entries: Iterable<readonly [string, string]>): string {
  return JSON.stringify(
    [...entries].filter(([, decision]) => decision !== 'default').sort(([a], [b]) => a.localeCompare(b)),
  )
}

export interface ScopePolicyFilters {
  textFilter: string
  setTextFilter: (v: string) => void
  decisionFilter: 'all' | PolicyDecision
  setDecisionFilter: (v: 'all' | PolicyDecision) => void
}

/**
 * Filter state for the scope list. Lives outside ScopePolicyEditorBody so a
 * parent can host the filter controls (e.g. in its section title row) while
 * the editor consumes the values. Resets when `resetKey` (e.g. the account id)
 * changes.
 */
export function useScopePolicyFilters(resetKey?: string): ScopePolicyFilters {
  const [textFilter, setTextFilter] = useState('')
  const [decisionFilter, setDecisionFilter] = useState<'all' | PolicyDecision>('all')
  useEffect(() => {
    setTextFilter('')
    setDecisionFilter('all')
  }, [resetKey])
  return { textFilter, setTextFilter, decisionFilter, setDecisionFilter }
}

/** Compact icon-button search + decision-filter controls for the scope list. */
export function ScopePolicyFilterControls({
  filters,
  className,
}: {
  filters: ScopePolicyFilters
  className?: string
}) {
  const { textFilter, setTextFilter, decisionFilter, setDecisionFilter } = filters
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  return (
    <div className={cn('flex items-center justify-end gap-1 min-w-0', className)}>
      {searchOpen ? (
        <div className="relative w-44 max-w-full">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Filter scopes..."
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            onBlur={() => {
              if (!textFilter.trim()) setSearchOpen(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setTextFilter('')
                setSearchOpen(false)
              }
            }}
            className="h-6 text-xs pl-6"
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="h-6 w-6 px-0 text-muted-foreground"
          aria-label="Search scopes"
          data-testid="scope-search-toggle"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
      )}
      <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              'relative h-6 w-6 px-0',
              decisionFilter === 'all' ? 'text-muted-foreground' : 'text-foreground',
            )}
            aria-label="Filter by decision"
            data-testid="scope-filter-toggle"
          >
            <ListFilter className="h-3.5 w-3.5" />
            {decisionFilter !== 'all' && (
              <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-32 p-1">
          {(['all', 'allow', 'review', 'block', 'default'] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`scope-filter-${v}`}
              onClick={() => {
                setDecisionFilter(v)
                setFilterMenuOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted',
                decisionFilter === v && 'bg-muted',
              )}
            >
              {(v === 'allow' || v === 'review' || v === 'block') && (
                <PolicyDecisionIcon decision={v} className="h-3 w-3" />
              )}
              <span className="capitalize">{v}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}

interface ScopePolicyEditorBodyProps {
  accountId: string
  toolkit: string
  /** Called after a successful save. */
  onSaved?: () => void
  /** Called when the user clicks Cancel. */
  onCancel?: () => void
  /** Hide the bottom action bar (Save/Cancel). When true, the parent is responsible for triggering save. */
  hideActions?: boolean
  /**
   * Externally-hosted filter state (from useScopePolicyFilters). When provided,
   * the editor consumes these values and does NOT render its own filter
   * toolbar — the parent renders ScopePolicyFilterControls wherever it wants.
   */
  filters?: ScopePolicyFilters
}

/**
 * Inline body of the scope policy editor — the same content as the Dialog
 * version, just without the Dialog frame. Reused on the connection detail page.
 */
export function ScopePolicyEditorBody({
  accountId,
  toolkit,
  onSaved,
  onCancel,
  hideActions,
  filters,
}: ScopePolicyEditorBodyProps) {
  const queryClient = useQueryClient()
  const [policies, setPolicies] = useState<ScopePolicy[]>([])
  const [accountDefault, setAccountDefault] = useState<PolicyDecision>('default')
  const [labelDefaults, setLabelDefaults] =
    useState<Record<ScopeLabel, PolicyDecision>>(emptyLabelDefaults)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // Snapshot of the persisted (non-default) policies, for dirty detection.
  const [savedSnapshot, setSavedSnapshot] = useState('')
  // Filter state: internal by default; a parent may host the controls and pass
  // its own (see ScopePolicyEditorBodyProps.filters).
  const internalFilters = useScopePolicyFilters(accountId)
  const { textFilter, decisionFilter } = filters ?? internalFilters
  // Risk-label groups are accordions, collapsed by default.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  // Get scopes from the scope map for this toolkit
  const provider = SCOPE_MAPS[toolkit]
  const allScopes = useMemo(
    () =>
      provider
        ? Array.isArray(provider.allScopes)
          ? provider.allScopes
          : Object.values(provider.allScopes).flat()
        : [],
    [provider],
  )

  // For each scope, prefer the curated description; otherwise borrow the
  // first endpoint description that mentions this scope.
  const scopeDescriptions = useMemo(() => {
    const descs: Record<string, string> = {}
    for (const scope of allScopes) {
      const desc =
        getScopeDescription(toolkit, scope) ??
        provider?.scopeMap.find(
          (e) => e.description && e.sufficientScopes.includes(scope),
        )?.description
      if (desc) descs[scope] = desc
    }
    return descs
  }, [allScopes, toolkit, provider])

  // Fetch existing policies
  useEffect(() => {
    setLoading(true)
    setFetchError(null)
    setOpenGroups({})
    apiFetch(`/api/policies/scope/${accountId}`)
      .then((res) => res.json())
      .then((data) => {
        const allPolicies: Array<{ scope: string; decision: string }> = data.policies || []
        const existing = new Map<string, PolicyDecision>()
        for (const p of allPolicies) {
          existing.set(p.scope, p.decision as PolicyDecision)
        }
        setAccountDefault(existing.get('*') ?? 'default')
        // For a brand-new (unconfigured) account, pre-fill the recommended baseline
        // so the user sees a sensible starting point — but it is only written if they
        // Save. Once the account has ANY saved policy, an absent label row means the
        // user left that group on "default" (inherit), so we honor that instead.
        const untouched = allPolicies.length === 0
        const labelDefaultFor = (key: ScopeLabel): PolicyDecision =>
          existing.get(labelDefaultKey(key)) ??
          (untouched ? LABEL_DEFAULT_BASELINE[key] : 'default')
        setLabelDefaults({
          read: labelDefaultFor('read'),
          write: labelDefaultFor('write'),
          destructive: labelDefaultFor('destructive'),
        })
        // Start with scopes from the static scope map
        const scopeSet = new Set(allScopes)
        const scopePolicies: ScopePolicy[] = allScopes.map((scope) => ({
          scope,
          decision: existing.get(scope) ?? 'default',
        }))
        // Merge in any DB-stored scopes not in the static map (e.g. set via session review prompt).
        // Skip the account '*' default and the '*read'/'*write'/'*destructive' label-default
        // sentinels — those are surfaced as group-level controls, not per-scope rows.
        for (const [scope, decision] of existing) {
          if (scope !== '*' && !isLabelDefaultKey(scope) && !scopeSet.has(scope)) {
            scopePolicies.push({ scope, decision })
          }
        }
        setPolicies(scopePolicies)
        // Persisted baseline for dirty detection. Note: an untouched account
        // has no saved rows, so the pre-filled baseline above reads as "dirty"
        // — Save stays enabled so the recommended defaults can be persisted.
        setSavedSnapshot(serializePolicies(existing))
        setLoading(false)
      })
      .catch((err) => {
        console.error('Failed to fetch scope policies:', err)
        setFetchError('Failed to load policies. Showing defaults.')
        setPolicies(allScopes.map((scope) => ({ scope, decision: 'default' })))
        setSavedSnapshot('[]')
        setLoading(false)
      })
  }, [accountId, allScopes])

  // Filtered policies
  const filteredPolicies = useMemo(() => {
    return policies.filter((p) => {
      // Decision filter
      if (decisionFilter !== 'all' && p.decision !== decisionFilter) return false
      // Text filter
      if (textFilter) {
        const q = textFilter.toLowerCase()
        const matchesScope = p.scope.toLowerCase().includes(q)
        const matchesDesc = scopeDescriptions[p.scope]?.toLowerCase().includes(q)
        if (!matchesScope && !matchesDesc) return false
      }
      return true
    })
  }, [policies, textFilter, decisionFilter, scopeDescriptions])

  // Group the (filtered) per-scope rows by their risk label.
  const groupedPolicies = useMemo(() => {
    const groups: Record<ScopeLabel | 'other', ScopePolicy[]> = {
      read: [],
      write: [],
      destructive: [],
      other: [],
    }
    for (const p of filteredPolicies) {
      const label = getScopeLabel(toolkit, p.scope)
      groups[label ?? 'other'].push(p)
    }
    return groups
  }, [filteredPolicies, toolkit])

  const setLabelDefault = (label: ScopeLabel, decision: PolicyDecision) => {
    setLabelDefaults((prev) => ({ ...prev, [label]: decision }))
    // Setting a group decision cascades to every scope in that group — including
    // rows hidden by an active filter — so rows never silently diverge from the
    // group control. Deselecting (back to 'default') clears them the same way.
    setPolicies((prev) =>
      prev.map((p) => (getScopeLabel(toolkit, p.scope) === label ? { ...p, decision } : p)),
    )
  }

  const setOpenGroup = (key: string, open: boolean) =>
    setOpenGroups((prev) => ({ ...prev, [key]: open }))

  // When the user is filtering, reveal matching groups regardless of collapse state.
  const filtering = textFilter.trim() !== '' || decisionFilter !== 'all'

  const resetToRecommended = () => {
    setLabelDefaults({
      read: LABEL_DEFAULT_BASELINE.read,
      write: LABEL_DEFAULT_BASELINE.write,
      destructive: LABEL_DEFAULT_BASELINE.destructive,
    })
    // "Recommended" is the pure-defaults state: group baselines with no
    // per-scope overrides, so clear every row back to inherit.
    setPolicies((prev) => prev.map((p) => ({ ...p, decision: 'default' as PolicyDecision })))
  }

  // The non-default policies that a Save would write, keyed by scope.
  const currentBatch = useMemo(() => {
    const batch = new Map<string, 'allow' | 'review' | 'block'>()
    if (accountDefault !== 'default') {
      batch.set('*', accountDefault as 'allow' | 'review' | 'block')
    }
    for (const g of LABEL_GROUPS) {
      const d = labelDefaults[g.key]
      if (d !== 'default') {
        batch.set(labelDefaultKey(g.key), d as 'allow' | 'review' | 'block')
      }
    }
    for (const p of policies) {
      if (p.decision !== 'default') {
        batch.set(p.scope, p.decision as 'allow' | 'review' | 'block')
      }
    }
    return batch
  }, [accountDefault, labelDefaults, policies])

  const currentSnapshot = useMemo(() => serializePolicies(currentBatch), [currentBatch])
  // Save is only meaningful when the editor differs from what's persisted.
  const isDirty = currentSnapshot !== savedSnapshot

  const handleSave = async () => {
    setSaving(true)
    try {
      const batch = [...currentBatch.entries()].map(([scope, decision]) => ({ scope, decision }))

      await apiFetch(`/api/policies/scope/${accountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: batch }),
      })
      queryClient.invalidateQueries({ queryKey: ['scope-policies', accountId] })
      setSavedSnapshot(currentSnapshot)
      onSaved?.()
    } catch (error) {
      console.error('Failed to save policies:', error)
    } finally {
      setSaving(false)
    }
  }

  const updateScopePolicy = (scope: string, decision: PolicyDecision) => {
    setPolicies((prev) =>
      prev.map((p) => (p.scope === scope ? { ...p, decision } : p))
    )
  }

  const renderRow = (p: ScopePolicy) => (
    <div
      key={p.scope}
      data-testid={`scope-row-${p.scope}`}
      className="flex items-center justify-between gap-2 py-2 pl-8 pr-2"
    >
      <div className="flex-1 min-w-0">
        <span className="text-xs font-mono font-medium">
          <HighlightMatch text={p.scope} query={textFilter} />
        </span>
        {scopeDescriptions[p.scope] && (
          <p className="text-[11px] text-muted-foreground truncate">
            <HighlightMatch text={scopeDescriptions[p.scope]} query={textFilter} />
          </p>
        )}
      </div>
      <PolicyDecisionToggle value={p.decision} onChange={(v) => updateScopePolicy(p.scope, v)} />
    </div>
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      {fetchError && (
        <div className="mx-3 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 rounded-md px-2 py-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {fetchError}
        </div>
      )}

      {/* Filters — hidden when the parent hosts the controls (filters prop) */}
      {allScopes.length > 0 && !filters && (
        <ScopePolicyFilterControls filters={internalFilters} className="pl-3 pr-2" />
      )}

      {/* Per-scope policies, grouped by risk label */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {allScopes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No scopes defined for this API.
          </p>
        ) : filteredPolicies.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No scopes match your filters.
          </p>
        ) : (
          <div className="divide-y divide-border/50">
            {LABEL_GROUPS.map((g) => {
              const rows = groupedPolicies[g.key]
              if (rows.length === 0) return null
              // Collapsed by default; a filter reveals matches, but an explicit
              // collapse/expand by the user (sets openGroups[key]) always wins —
              // so the trigger never feels "dead" while filtering.
              const isOpen = openGroups[g.key] ?? filtering
              return (
                <Collapsible
                  key={g.key}
                  open={isOpen}
                  onOpenChange={(o) => setOpenGroup(g.key, o)}
                  data-testid={`scope-group-${g.key}`}
                  className="divide-y divide-border/50"
                >
                  <div
                    data-testid={`group-default-${g.key}`}
                    className="flex items-center justify-between gap-2 bg-background py-2 pl-3 pr-2 transition-colors hover:bg-muted/30"
                  >
                    <CollapsibleTrigger
                      data-testid={`scope-group-toggle-${g.key}`}
                      className="flex flex-1 items-center gap-1.5 min-w-0 text-left"
                    >
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span className="text-xs font-medium">{g.title}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">
                        {rows.length}
                      </span>
                    </CollapsibleTrigger>
                    <PolicyDecisionDropdown
                      value={labelDefaults[g.key]}
                      onChange={(v) => setLabelDefault(g.key, v)}
                    />
                  </div>
                  <CollapsibleContent className="divide-y divide-border/50">
                    {rows.map(renderRow)}
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
            {groupedPolicies.other.length > 0 && (
              <Collapsible
                open={openGroups.other ?? filtering}
                onOpenChange={(o) => setOpenGroup('other', o)}
                data-testid="scope-group-other"
                className="divide-y divide-border/50"
              >
                <div className="flex items-center bg-background py-2 pl-3 pr-2 transition-colors hover:bg-muted/30">
                  <CollapsibleTrigger
                    data-testid="scope-group-toggle-other"
                    className="flex flex-1 items-center gap-1.5 min-w-0 text-left"
                  >
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        (openGroups.other ?? filtering) && 'rotate-90',
                      )}
                    />
                    <span className="text-xs font-medium">Other actions</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">
                      {groupedPolicies.other.length}
                    </span>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent className="divide-y divide-border/50">
                  {groupedPolicies.other.map(renderRow)}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </div>

      {/* Account default — the fallback tier, so it reads below the groups */}
      {/* -mt-3 cancels the parent gap so the divider above sits in the same
          16px rhythm as the list's divide-y hairlines */}
      <div className="-mt-3 flex items-center justify-between gap-3 border-t border-border/50 py-3.5 pl-3 pr-2">
        <span className="text-[11px] text-muted-foreground truncate min-w-0">
          Fallback for scopes without a per-scope or risk-level policy
        </span>
        <div className="shrink-0">
          <PolicyDecisionToggle
            value={accountDefault}
            onChange={(v) => setAccountDefault(v)}
          />
        </div>
      </div>
      {!hideActions && (
        <div className="flex items-center justify-end gap-2 pl-3 pr-2">
          {allScopes.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetToRecommended}
              data-testid="reset-recommended-defaults"
              className="mr-auto text-muted-foreground hover:text-foreground"
            >
              <Undo2 className="h-3.5 w-3.5 mr-1.5" />
              Reset defaults
            </Button>
          )}
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button data-testid="scope-policy-save" size="sm" onClick={handleSave} disabled={saving || !isDirty}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save
          </Button>
        </div>
      )}
    </div>
  )
}

interface ScopePolicySectionProps {
  accountId: string
  toolkit: string
  /** Called after a successful save. */
  onSaved?: () => void
  /** Called when the user clicks Cancel. When omitted, no Cancel button renders. */
  onCancel?: () => void
  /** Section label; defaults to "Permissions". */
  title?: React.ReactNode
  className?: string
}

/**
 * Self-contained "Permissions" panel: the muted section title with search/filter
 * controls, and the bordered card holding the scope policy editor. Rendered
 * identically on the connection detail page and inside the policy dialog.
 */
export function ScopePolicySection({
  accountId,
  toolkit,
  onSaved,
  onCancel,
  title = 'Permissions',
  className,
}: ScopePolicySectionProps) {
  const filters = useScopePolicyFilters(accountId)
  return (
    <section className={cn('flex min-h-0 min-w-0 flex-col space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-normal text-muted-foreground shrink-0">{title}</h3>
        <ScopePolicyFilterControls filters={filters} className="flex-1" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background py-2">
        <ScopePolicyEditorBody
          accountId={accountId}
          toolkit={toolkit}
          filters={filters}
          onSaved={onSaved}
          onCancel={onCancel}
        />
      </div>
    </section>
  )
}

interface ScopePolicyEditorProps {
  accountId: string
  toolkit: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional custom header to replace the default title. */
  header?: React.ReactNode
}

export function ScopePolicyEditor({
  accountId,
  toolkit,
  open,
  onOpenChange,
  header,
}: ScopePolicyEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No visible dialog title or X — the section label carries the title and
          Cancel handles dismissal. The sr-only title keeps the dialog labeled
          for screen readers. */}
      <DialogContent hideClose className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogTitle className="sr-only">Agent permissions for {toolkit}</DialogTitle>
        <DialogDescription className="sr-only">Configure per-scope access policies for {toolkit}</DialogDescription>
        {header && <DialogHeader>{header}</DialogHeader>}
        <ScopePolicySection
          accountId={accountId}
          toolkit={toolkit}
          title={
            <>
              Agent permissions for <span className="capitalize">{toolkit}</span>
            </>
          }
          className={cn('flex-1 min-h-0 mb-6', header ? 'mt-5' : 'mt-1')}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
