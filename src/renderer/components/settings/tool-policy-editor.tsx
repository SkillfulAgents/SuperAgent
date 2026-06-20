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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'

type PolicyDecision = 'allow' | 'review' | 'block' | 'default'

interface ToolPolicy {
  toolName: string
  decision: PolicyDecision
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

interface ToolPolicyEditorBodyProps {
  mcpId: string
  tools: Array<{ name: string; description?: string }>
  onSaved?: () => void
  onCancel?: () => void
  hideActions?: boolean
  allowSaveWithoutChanges?: boolean
}

/**
 * Inline body of the tool policy editor — same content as the Dialog version,
 * just without the Dialog frame. Reused on the connection detail page.
 */
export function ToolPolicyEditorBody({
  mcpId,
  tools,
  onSaved,
  onCancel,
  hideActions,
  allowSaveWithoutChanges = false,
}: ToolPolicyEditorBodyProps) {
  const queryClient = useQueryClient()
  const [policies, setPolicies] = useState<ToolPolicy[]>([])
  const [mcpDefault, setMcpDefault] = useState<PolicyDecision>('default')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // Snapshot of the persisted (non-default) policies, for dirty detection.
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [textFilter, setTextFilter] = useState('')
  const [decisionFilter, setDecisionFilter] = useState<'all' | PolicyDecision>('all')

  // Fetch existing policies
  useEffect(() => {
    setLoading(true)
    setFetchError(null)
    setTextFilter('')
    setDecisionFilter('all')
    apiFetch(`/api/policies/tool/${mcpId}`)
      .then((res) => res.json())
      .then((data) => {
        const existing = new Map<string, PolicyDecision>()
        for (const p of data.policies || []) {
          existing.set(p.toolName, p.decision as PolicyDecision)
        }
        setMcpDefault(existing.get('*') ?? 'default')
        const toolPolicies: ToolPolicy[] = tools.map((tool) => ({
          toolName: tool.name,
          decision: existing.get(tool.name) ?? 'default',
        }))
        setPolicies(toolPolicies)
        setSavedSnapshot(serializePolicies(existing))
        setLoading(false)
      })
      .catch((err) => {
        console.error('Failed to fetch tool policies:', err)
        setFetchError('Failed to load policies. Showing defaults.')
        setPolicies(tools.map((tool) => ({ toolName: tool.name, decision: 'default' })))
        setSavedSnapshot('[]')
        setLoading(false)
      })
  }, [mcpId, tools])

  // Filtered policies
  const filteredPolicies = useMemo(() => {
    return policies.filter((p) => {
      if (decisionFilter !== 'all' && p.decision !== decisionFilter) return false
      if (textFilter) {
        const q = textFilter.toLowerCase()
        const tool = tools.find((t) => t.name === p.toolName)
        const matchesName = p.toolName.toLowerCase().includes(q)
        const matchesDesc = tool?.description?.toLowerCase().includes(q)
        if (!matchesName && !matchesDesc) return false
      }
      return true
    })
  }, [policies, textFilter, decisionFilter, tools])

  // The non-default policies that a Save would write, keyed by tool name.
  const currentBatch = useMemo(() => {
    const batch = new Map<string, 'allow' | 'review' | 'block'>()
    if (mcpDefault !== 'default') {
      batch.set('*', mcpDefault as 'allow' | 'review' | 'block')
    }
    for (const p of policies) {
      if (p.decision !== 'default') {
        batch.set(p.toolName, p.decision as 'allow' | 'review' | 'block')
      }
    }
    return batch
  }, [mcpDefault, policies])

  const currentSnapshot = useMemo(() => serializePolicies(currentBatch), [currentBatch])
  // Save is only meaningful when the editor differs from what's persisted.
  const isDirty = currentSnapshot !== savedSnapshot
  const canSave = isDirty || allowSaveWithoutChanges

  const handleSave = async () => {
    setSaving(true)
    try {
      const batch = [...currentBatch.entries()].map(([toolName, decision]) => ({ toolName, decision }))

      await apiFetch(`/api/policies/tool/${mcpId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: batch }),
      })
      queryClient.invalidateQueries({ queryKey: ['tool-policies', mcpId] })
      setSavedSnapshot(currentSnapshot)
      onSaved?.()
    } catch (error) {
      console.error('Failed to save policies:', error)
    } finally {
      setSaving(false)
    }
  }

  const updateToolPolicy = (toolName: string, decision: PolicyDecision) => {
    setPolicies((prev) =>
      prev.map((p) => (p.toolName === toolName ? { ...p, decision } : p))
    )
  }

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

      {/* MCP default */}
      <div className="flex items-center justify-between rounded-md border p-2">
        <div>
          <span className="text-sm font-medium">MCP Default</span>
          <p className="text-xs text-muted-foreground">
            Applies to tools without an explicit policy
          </p>
        </div>
        <PolicyDecisionToggle
          value={mcpDefault}
          onChange={(v) => setMcpDefault(v)}
          size="md"
        />
      </div>

      {/* Filters */}
      {tools.length > 0 && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Filter tools..."
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

      {/* Per-tool policies */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No tools discovered for this MCP server.
          </p>
        ) : filteredPolicies.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No tools match your filters.
          </p>
        ) : (
          <div className="space-y-1">
            {filteredPolicies.map((p) => {
              const tool = tools.find((t) => t.name === p.toolName)
              return (
                <div
                  key={p.toolName}
                  data-testid={`tool-row-${p.toolName}`}
                  className="flex items-center justify-between rounded border px-2 py-1.5"
                >
                  <div className="flex-1 min-w-0 mr-2">
                    <span className="text-xs font-mono font-medium">
                      <HighlightMatch text={p.toolName} query={textFilter} />
                    </span>
                    {tool?.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        <HighlightMatch text={tool.description} query={textFilter} />
                      </p>
                    )}
                  </div>
                  <PolicyDecisionToggle
                    value={p.decision}
                    onChange={(v) => updateToolPolicy(p.toolName, v)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {!hideActions && (
        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button data-testid="tool-policy-save" size="sm" onClick={handleSave} disabled={saving || !canSave}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save Policies
          </Button>
        </div>
      )}
    </div>
  )
}

interface ToolPolicyEditorProps {
  mcpId: string
  mcpName: string
  tools: Array<{ name: string; description?: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
  allowSaveWithoutChanges?: boolean
}

export function ToolPolicyEditor({
  mcpId,
  mcpName,
  tools,
  open,
  onOpenChange,
  allowSaveWithoutChanges,
}: ToolPolicyEditorProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{mcpName} Tool Policies</DialogTitle>
          <DialogDescription className="sr-only">Configure per-tool access policies for {mcpName}</DialogDescription>
        </DialogHeader>
        <ToolPolicyEditorBody
          mcpId={mcpId}
          tools={tools}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
          allowSaveWithoutChanges={allowSaveWithoutChanges}
        />
      </DialogContent>
    </Dialog>
  )
}
