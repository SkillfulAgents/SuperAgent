import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, Search, AlertCircle, Eye, Pencil, Trash2, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
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
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
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
  hint: string
  Icon: typeof Eye
}> = [
  { key: 'read', title: 'Read', hint: 'View-only access', Icon: Eye },
  { key: 'write', title: 'Write', hint: 'Create, update, edit, delete items', Icon: Pencil },
  {
    key: 'destructive',
    title: 'Destructive',
    hint: 'Irreversible deletion or admin/governance',
    Icon: Trash2,
  },
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

interface ScopePolicyEditorBodyProps {
  accountId: string
  toolkit: string
  /** Called after a successful save. */
  onSaved?: () => void
  /** Called when the user clicks Cancel. */
  onCancel?: () => void
  /** Hide the bottom action bar (Save/Cancel). When true, the parent is responsible for triggering save. */
  hideActions?: boolean
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
  const [textFilter, setTextFilter] = useState('')
  const [decisionFilter, setDecisionFilter] = useState<'all' | PolicyDecision>('all')
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
    setTextFilter('')
    setDecisionFilter('all')
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

  const setLabelDefault = (label: ScopeLabel, decision: PolicyDecision) =>
    setLabelDefaults((prev) => ({ ...prev, [label]: decision }))

  const setOpenGroup = (key: string, open: boolean) =>
    setOpenGroups((prev) => ({ ...prev, [key]: open }))

  // When the user is filtering, reveal matching groups regardless of collapse state.
  const filtering = textFilter.trim() !== '' || decisionFilter !== 'all'

  const resetToRecommended = () =>
    setLabelDefaults({
      read: LABEL_DEFAULT_BASELINE.read,
      write: LABEL_DEFAULT_BASELINE.write,
      destructive: LABEL_DEFAULT_BASELINE.destructive,
    })

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
      className="flex items-center justify-between rounded border px-2 py-1.5"
    >
      <div className="flex-1 min-w-0 mr-2">
        <span className="text-xs font-mono font-medium">
          <HighlightMatch text={p.scope} query={textFilter} />
        </span>
        {scopeDescriptions[p.scope] && (
          <p className="text-xs text-muted-foreground truncate">
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
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 rounded-md px-2 py-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {fetchError}
        </div>
      )}

      {/* Account default */}
      <div className="flex items-center justify-between rounded-md border p-2">
        <div>
          <span className="text-sm font-medium">Account Default</span>
          <p className="text-xs text-muted-foreground">
            Fallback for scopes without a per-scope or risk-level policy
          </p>
        </div>
        <PolicyDecisionToggle
          value={accountDefault}
          onChange={(v) => setAccountDefault(v)}
          size="md"
        />
      </div>

      {/* Filters */}
      {allScopes.length > 0 && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter scopes..."
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              className="h-8 text-xs pl-7"
            />
          </div>
          <Select
            value={decisionFilter}
            onValueChange={(v) => setDecisionFilter(v as 'all' | PolicyDecision)}
          >
            <SelectTrigger className="w-[100px] h-8 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="allow">Allow</SelectItem>
              <SelectItem value="review">Review</SelectItem>
              <SelectItem value="block">Block</SelectItem>
              <SelectItem value="default">Default</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {allScopes.length > 0 && (
        <button
          type="button"
          onClick={resetToRecommended}
          data-testid="reset-recommended-defaults"
          className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2"
        >
          Reset risk-level defaults to recommended
        </button>
      )}

      {/* Per-scope policies, grouped by risk label */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-3">
        {allScopes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No scopes defined for this API.
          </p>
        ) : filteredPolicies.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No scopes match your filters.
          </p>
        ) : (
          <>
            {LABEL_GROUPS.map((g) => {
              const rows = groupedPolicies[g.key]
              if (rows.length === 0) return null
              const Icon = g.Icon
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
                  className="space-y-1"
                >
                  <div
                    data-testid={`group-default-${g.key}`}
                    className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1.5"
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
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-xs font-semibold">{g.title}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        ({rows.length})
                      </span>
                      <span className="text-xs text-muted-foreground truncate">· {g.hint}</span>
                    </CollapsibleTrigger>
                    <PolicyDecisionToggle
                      value={labelDefaults[g.key]}
                      onChange={(v) => setLabelDefault(g.key, v)}
                    />
                  </div>
                  <CollapsibleContent className="space-y-1 pl-1">
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
                className="space-y-1"
              >
                <CollapsibleTrigger
                  data-testid="scope-group-toggle-other"
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                      (openGroups.other ?? filtering) && 'rotate-90',
                    )}
                  />
                  <span className="text-xs font-semibold">Other</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    ({groupedPolicies.other.length})
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    · uses the account default
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-1 pl-1">
                  {groupedPolicies.other.map(renderRow)}
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </div>
      {!hideActions && (
        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button data-testid="scope-policy-save" size="sm" onClick={handleSave} disabled={saving || !isDirty}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save Policies
          </Button>
        </div>
      )}
    </div>
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
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          {header ?? <DialogTitle className="capitalize">{toolkit} Scope Policies</DialogTitle>}
          <DialogDescription className="sr-only">Configure per-scope access policies for {toolkit}</DialogDescription>
        </DialogHeader>
        <ScopePolicyEditorBody
          accountId={accountId}
          toolkit={toolkit}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
