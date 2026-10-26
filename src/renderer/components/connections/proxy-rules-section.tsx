import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Trash2 } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useAgents } from '@renderer/hooks/use-agents'
import { useAccountAgents } from '@renderer/hooks/use-connected-accounts'
import { useMcpAgents } from '@renderer/hooks/use-remote-mcps'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useUser } from '@renderer/context/user-context'
import { AgentDropdown } from '@renderer/components/agents/agent-dropdown'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { InlineCode } from '@renderer/components/ui/inline-code'
import { cn } from '@shared/lib/utils/cn'
import { ruleEffectLabel, type RuleEffectView } from '@shared/lib/proxy/rules/proposal-schema'

type RuleKind = 'api' | 'mcp'

interface RuleTestCase { name: string; input: Record<string, unknown>; expect: boolean }

interface RuleView {
  id: string
  agentSlug: string | null
  createdBy: 'user' | 'agent'
  createdByAgentSlug: string | null
  updatedAt: string
  version: number
  effect: RuleEffectView
  name: string
  description: string
  restatement: string
  patterns: string[]
  code: string
  tests: RuleTestCase[]
  warnings: string[]
}

type AppliesTo = 'agent' | 'all_agents'

/**
 * The first message of the chat that writes a rule: the person's words, the
 * connection, and who the rule should apply to. The agent proposes the rule
 * with its rule tools, and the person approves it on the card in that chat.
 */
export function ruleRequestPrompt(request: {
  kind: RuleKind
  targetId: string
  targetName: string
  description: string
  appliesTo: AppliesTo
}): string {
  const target = request.kind === 'api'
    ? `the connected account "${request.targetName}" (account id ${request.targetId})`
    : `the MCP server "${request.targetName}" (MCP id ${request.targetId})`
  const scope = request.appliesTo === 'agent' ? 'only your requests' : 'every agent using this connection'
  return [
    `Create a proxy rule for ${target}:`,
    '',
    request.description.trim().split('\n').map((line) => `> ${line}`).join('\n'),
    '',
    `It should apply to ${scope}. Check the rules it already has first, and ask me before submitting if anything is unclear, such as which requests it should cover or whether it should let them skip review or hold them for review.`,
  ].join('\n')
}

interface ProxyRulesSectionProps {
  kind: RuleKind
  /** Connected account id (api) or remote MCP server id (mcp). */
  targetId: string
  /** The account's or server's display name. */
  targetName: string
  /** The agent whose connections this page was opened from, if any. */
  agentSlug?: string
}

/**
 * "Rules" panel on a connection: rules that let specific requests skip the
 * review the permissions above would ask for, or hold ones they allow. A rule
 * is written by an agent: the person describes it here, which starts a chat
 * where the agent writes it and the person approves it.
 */
export function ProxyRulesSection({ kind, targetId, targetName, agentSlug }: ProxyRulesSectionProps) {
  const queryKey = ['proxy-rules', kind, targetId]
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)

  const { data, isLoading, error: loadError, refetch } = useQuery<{ rules: RuleView[] }>({
    queryKey,
    queryFn: async () => {
      const res = await apiFetch(`/api/proxy-rules/${kind}/${targetId}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `Rules could not be loaded (HTTP ${res.status}).`)
      }
      return res.json()
    },
  })

  const remove = useMutation({
    mutationFn: async (ruleId: string) => {
      const res = await apiFetch(`/api/proxy-rules/${kind}/${targetId}/${ruleId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `The rule could not be deleted (HTTP ${res.status}).`)
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const rules = data?.rules ?? []
  const { data: agents } = useAgents()
  const agentName = (slug: string) => agents?.find((a) => a.slug === slug)?.name ?? slug

  return (
    <section className="space-y-2 min-w-0" data-testid="proxy-rules-section">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-normal text-muted-foreground">Rules</h3>
        {!adding && (
          <Button size="xs" variant="outline" onClick={() => setAdding(true)} data-testid="proxy-rules-add">
            Add rule
          </Button>
        )}
      </div>
      <div className="rounded-xl border bg-background overflow-hidden">
        <p className="px-3 pt-3 text-xs text-muted-foreground">
          Rules either let requests that would go to review through, or hold requests your permissions allow for review. Rules never block anything.
        </p>
        {isLoading ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
        ) : loadError ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-red-600" role="alert" data-testid="proxy-rules-load-error">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{loadError.message}</span>
            <Button size="xs" variant="outline" onClick={() => void refetch()}>Retry</Button>
          </div>
        ) : rules.length === 0 && !adding ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No rules yet.</p>
        ) : (
          <ul className="divide-y">
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                agentName={agentName}
                onDelete={() => remove.mutate(rule.id)}
                deleting={remove.isPending && remove.variables === rule.id}
              />
            ))}
          </ul>
        )}
        {remove.error && (
          <p className="px-3 pb-3 text-xs text-red-600" role="alert" data-testid="proxy-rules-delete-error">{remove.error.message}</p>
        )}
        {adding && (
          <RuleRequestForm
            kind={kind}
            targetId={targetId}
            targetName={targetName}
            contextAgentSlug={agentSlug}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </section>
  )
}

function RuleRow({ rule, agentName, onDelete, deleting }: {
  rule: RuleView
  agentName: (slug: string) => string
  onDelete: () => void
  deleting: boolean
}) {
  const [open, setOpen] = useState(false)
  const origin = rule.createdBy === 'agent'
    ? `Proposed by ${rule.createdByAgentSlug ? agentName(rule.createdByAgentSlug) : 'an agent'}`
    : 'Added by you'
  const scope = rule.agentSlug ? agentName(rule.agentSlug) : 'All agents'
  return (
    <li data-testid="proxy-rule-row">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 px-3 py-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
            <span className="truncate text-sm text-foreground" data-testid="proxy-rule-name">{rule.name || rule.description}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {ruleEffectLabel(rule.effect)} · {scope}
            </span>
          </CollapsibleTrigger>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onDelete}
            disabled={deleting}
            aria-label="Delete rule"
            data-testid="proxy-rule-delete"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <CollapsibleContent>
          <div className="px-3 pb-3 pl-8">
            {rule.restatement && <p className="text-xs leading-5 text-foreground/85"><InlineCode text={rule.restatement} /></p>}
            <p className="mt-1 text-xs text-muted-foreground">{origin} · v{rule.version}</p>
            <RuleDetails description={rule.description} patterns={rule.patterns} code={rule.code} warnings={rule.warnings} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function RuleDetails({ description, patterns, code, warnings }: { description: string; patterns: string[]; code: string; warnings: string[] }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      <p className="text-muted-foreground">Requested as: <span className="text-foreground/85"><InlineCode text={description} /></span></p>
      <div className="flex flex-wrap gap-1">
        {patterns.map((p) => <span key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{p}</span>)}
      </div>
      {warnings.length > 0 && <Warnings warnings={warnings} />}
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] leading-5">{code}</pre>
    </div>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
      {warnings.map((w) => (
        <p key={w} className="flex gap-2 text-xs leading-5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span>{w}</span>
        </p>
      ))}
    </div>
  )
}

function RuleRequestForm({ kind, targetId, targetName, contextAgentSlug, onCancel }: {
  kind: RuleKind
  targetId: string
  targetName: string
  contextAgentSlug?: string
  onCancel: () => void
}) {
  const navigate = useNavigate()
  const { isAuthMode, rolesReady, canUseAgent } = useUser()
  const agents = useAgents()
  const accountAgents = useAccountAgents(kind === 'api' ? targetId : '')
  const mcpAgents = useMcpAgents(kind === 'mcp' ? targetId : '')
  const assignment = kind === 'api' ? accountAgents : mcpAgents
  const createSession = useCreateSession()

  // Only an agent with this connection can propose a rule for it.
  const assigned = new Set(assignment.data?.agentSlugs ?? [])
  const candidates = (agents.data ?? []).filter((a) => assigned.has(a.slug) && (!isAuthMode || canUseAgent(a.slug)))
  const loading = agents.isLoading || assignment.isLoading || (isAuthMode && !rolesReady)
  const preselected = contextAgentSlug && candidates.some((a) => a.slug === contextAgentSlug)
    ? contextAgentSlug
    : candidates.length === 1 ? candidates[0].slug : null

  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [appliesTo, setAppliesTo] = useState<AppliesTo>(contextAgentSlug ? 'agent' : 'all_agents')
  const writer = candidates.find((a) => a.slug === (picked ?? preselected))

  const submit = () => {
    if (!writer || !description.trim()) return
    createSession.mutate(
      { agentSlug: writer.slug, message: ruleRequestPrompt({ kind, targetId, targetName, description, appliesTo }) },
      { onSuccess: (session) => void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: writer.slug, sessionId: session.id } }) },
    )
  }

  return (
    <div className="space-y-3 border-t px-3 py-3" data-testid="proxy-rule-composer">
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={kind === 'api'
          ? 'e.g. Let it send email when every recipient is at our company domain'
          : 'e.g. Let it request payments up to $5,000'}
        rows={2}
        disabled={createSession.isPending}
        data-testid="proxy-rule-description"
      />

      {loading ? null : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="proxy-rule-no-agent">
          An agent writes each rule, and no agent you can use has this connection. Give one access above to write rules for it.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <AgentDropdown
            value={writer?.slug ?? null}
            onValueChange={(slug) => setPicked(slug)}
            filter={(a) => candidates.some((c) => c.slug === a.slug)}
            disabled={createSession.isPending}
            testId="proxy-rule-agent"
            trigger={
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" data-testid="proxy-rule-agent-trigger">
                <span className="max-w-[12rem] truncate">{writer ? writer.name : 'Choose an agent'}</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </Button>
            }
          />
          <Select value={appliesTo} onValueChange={(value) => setAppliesTo(value as AppliesTo)} disabled={createSession.isPending}>
            <SelectTrigger className="h-8 w-auto gap-1.5 text-xs" aria-label="Applies to" data-testid="proxy-rule-applies-to">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Only {writer ? writer.name : 'that agent'}</SelectItem>
              <SelectItem value="all_agents">All agents</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Opens a chat where {writer ? writer.name : 'the agent'} writes the rule. You approve it there before it is saved.
      </p>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={createSession.isPending}>Cancel</Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={createSession.isPending || !writer || !description.trim()}
          data-testid="proxy-rule-create"
        >
          {createSession.isPending ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Starting…</> : 'Create rule'}
        </Button>
      </div>
    </div>
  )
}
