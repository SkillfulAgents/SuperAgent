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
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'

type PolicyDecision = 'allow' | 'review' | 'block' | 'default'

interface ToolPolicy {
  toolName: string
  decision: PolicyDecision
}

interface ToolPolicyEditorProps {
  mcpId: string
  mcpName: string
  tools: Array<{ name: string; description?: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ToolPolicyEditor({
  mcpId,
  mcpName,
  tools,
  open,
  onOpenChange,
}: ToolPolicyEditorProps) {
  const queryClient = useQueryClient()
  const [policies, setPolicies] = useState<ToolPolicy[]>([])
  const [mcpDefault, setMcpDefault] = useState<PolicyDecision>('default')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [textFilter, setTextFilter] = useState('')
  const [decisionFilter, setDecisionFilter] = useState<'all' | PolicyDecision>('all')

  // Fetch existing policies
  useEffect(() => {
    if (!open) return
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
        setLoading(false)
      })
      .catch((err) => {
        console.error('Failed to fetch tool policies:', err)
        setFetchError('Failed to load policies. Showing defaults.')
        setPolicies(tools.map((tool) => ({ toolName: tool.name, decision: 'default' })))
        setLoading(false)
      })
  }, [open, mcpId])

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

  const handleSave = async () => {
    setSaving(true)
    try {
      const batch: Array<{ toolName: string; decision: 'allow' | 'review' | 'block' }> = []
      if (mcpDefault !== 'default') {
        batch.push({ toolName: '*', decision: mcpDefault as 'allow' | 'review' | 'block' })
      }
      for (const p of policies) {
        if (p.decision !== 'default') {
          batch.push({ toolName: p.toolName, decision: p.decision as 'allow' | 'review' | 'block' })
        }
      }

      await apiFetch(`/api/policies/tool/${mcpId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: batch }),
      })
      queryClient.invalidateQueries({ queryKey: ['tool-policies', mcpId] })
      onOpenChange(false)
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{mcpName} Tool Policies</DialogTitle>
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
            <div className="flex-1 overflow-y-auto">
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
          </>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save Policies
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
