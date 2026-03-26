import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, Search, AlertCircle } from 'lucide-react'
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
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { SCOPE_MAPS } from '@shared/lib/proxy/scope-maps'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'

type PolicyDecision = 'allow' | 'review' | 'block' | 'default'

interface ScopePolicy {
  scope: string
  decision: PolicyDecision
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
  const queryClient = useQueryClient()
  const [policies, setPolicies] = useState<ScopePolicy[]>([])
  const [accountDefault, setAccountDefault] = useState<PolicyDecision>('default')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [textFilter, setTextFilter] = useState('')
  const [decisionFilter, setDecisionFilter] = useState<'all' | PolicyDecision>('all')

  // Get scopes from the scope map for this toolkit
  const provider = SCOPE_MAPS[toolkit]
  const allScopes = provider
    ? Array.isArray(provider.allScopes)
      ? provider.allScopes
      : Object.values(provider.allScopes).flat()
    : []

  // Build descriptions from scope map entries
  const scopeDescriptions: Record<string, string> = {}
  if (provider) {
    for (const entry of provider.scopeMap) {
      for (const scope of entry.sufficientScopes) {
        if (!scopeDescriptions[scope] && entry.description) {
          scopeDescriptions[scope] = entry.description
        }
      }
    }
  }

  // Fetch existing policies
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setFetchError(null)
    setTextFilter('')
    setDecisionFilter('all')
    apiFetch(`/api/policies/scope/${accountId}`)
      .then((res) => res.json())
      .then((data) => {
        const existing = new Map<string, PolicyDecision>()
        for (const p of data.policies || []) {
          existing.set(p.scope, p.decision as PolicyDecision)
        }
        setAccountDefault(existing.get('*') ?? 'default')
        // Start with scopes from the static scope map
        const scopeSet = new Set(allScopes)
        const scopePolicies: ScopePolicy[] = allScopes.map((scope) => ({
          scope,
          decision: existing.get(scope) ?? 'default',
        }))
        // Merge in any DB-stored scopes not in the static map (e.g. set via session review prompt)
        for (const [scope, decision] of existing) {
          if (scope !== '*' && !scopeSet.has(scope)) {
            scopePolicies.push({ scope, decision })
          }
        }
        setPolicies(scopePolicies)
        setLoading(false)
      })
      .catch((err) => {
        console.error('Failed to fetch scope policies:', err)
        setFetchError('Failed to load policies. Showing defaults.')
        setPolicies(allScopes.map((scope) => ({ scope, decision: 'default' })))
        setLoading(false)
      })
  }, [open, accountId, toolkit])

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

  const handleSave = async () => {
    setSaving(true)
    try {
      const batch: Array<{ scope: string; decision: 'allow' | 'review' | 'block' }> = []
      if (accountDefault !== 'default') {
        batch.push({ scope: '*', decision: accountDefault as 'allow' | 'review' | 'block' })
      }
      for (const p of policies) {
        if (p.decision !== 'default') {
          batch.push({ scope: p.scope, decision: p.decision as 'allow' | 'review' | 'block' })
        }
      }

      await apiFetch(`/api/policies/scope/${accountId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: batch }),
      })
      queryClient.invalidateQueries({ queryKey: ['scope-policies', accountId] })
      onOpenChange(false)
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          {header ?? <DialogTitle className="capitalize">{toolkit} Scope Policies</DialogTitle>}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
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
                  Applies to scopes without an explicit policy
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
                  <SelectTrigger className="w-[100px] h-8 text-xs shrink-0">
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

            {/* Per-scope policies */}
            <div className="flex-1 overflow-y-auto">
              {allScopes.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No scopes defined for this API.
                </p>
              ) : filteredPolicies.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No scopes match your filters.
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredPolicies.map((p) => (
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
                      <PolicyDecisionToggle
                        value={p.decision}
                        onChange={(v) => updateScopePolicy(p.scope, v)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="scope-policy-save" size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save Policies
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
