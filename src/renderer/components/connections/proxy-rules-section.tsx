import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, Loader2, Trash2, X } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useAgents } from '@renderer/hooks/use-agents'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Input } from '@renderer/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { cn } from '@shared/lib/utils/cn'
import { ruleEffectLabel, ruleTestExpectLabel, type RuleEffectView } from '@shared/lib/proxy/rules/proposal-schema'

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

interface Draft { effect: RuleEffectView; description: string; patterns: string[]; code: string; tests: RuleTestCase[] }

interface DraftReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  testResults: Array<{ name: string; expect: boolean; passed: boolean; error?: string; outcome: { result: string } }>
}

type AuthorResponse =
  | { type: 'question'; question: string }
  | { type: 'draft'; draft: Draft; name: string; restatement: string; report: DraftReport; coverage: string[] }

interface ProxyRulesSectionProps {
  kind: RuleKind
  /** Connected account id (api) or remote MCP server id (mcp). */
  targetId: string
}

/**
 * "Rules" panel on a connection: rules that let specific requests skip the
 * review the permissions above would ask for. Rules are written from a plain
 * English description; the user saves only after reading what the code does.
 */
export function ProxyRulesSection({ kind, targetId }: ProxyRulesSectionProps) {
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
          <RuleComposer
            kind={kind}
            targetId={targetId}
            onDone={() => {
              setAdding(false)
              void queryClient.invalidateQueries({ queryKey })
            }}
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
            {rule.restatement && <p className="text-xs leading-5 text-foreground/85">{rule.restatement}</p>}
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
      <p className="text-muted-foreground">Requested as: <span className="text-foreground/85">{description}</span></p>
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

function RuleComposer({ kind, targetId, onDone }: { kind: RuleKind; targetId: string; onDone: () => void }) {
  const [description, setDescription] = useState('')
  const [clarifications, setClarifications] = useState<Array<{ question: string; answer: string }>>([])
  const [question, setQuestion] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [name, setName] = useState('')
  const [result, setResult] = useState<Extract<AuthorResponse, { type: 'draft' }> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const author = useMutation({
    mutationFn: async (answers: Array<{ question: string; answer: string }>) => {
      const res = await apiFetch(`/api/proxy-rules/${kind}/${targetId}/author`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, clarifications: answers }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Could not write the rule')
      return body as AuthorResponse
    },
    onSuccess: (response) => {
      setError(null)
      if (response.type === 'question') {
        setQuestion(response.question)
        setResult(null)
      } else {
        setQuestion(null)
        setName(response.name)
        setResult(response)
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not write the rule'),
  })

  const save = useMutation({
    mutationFn: async (draft: Draft) => {
      const res = await apiFetch(`/api/proxy-rules/${kind}/${targetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft, ...(name.trim() ? { name: name.trim() } : {}) }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error((body.errors ?? [body.error]).join(' ') || 'Could not save the rule')
    },
    onSuccess: onDone,
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save the rule'),
  })

  const submitAnswer = () => {
    if (!question || !answer.trim()) return
    const next = [...clarifications, { question, answer: answer.trim() }]
    setClarifications(next)
    setQuestion(null)
    setAnswer('')
    author.mutate(next)
  }

  const busy = author.isPending || save.isPending
  const report = result?.report

  return (
    <div className="space-y-3 border-t px-3 py-3" data-testid="proxy-rule-composer">
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={kind === 'api'
          ? 'e.g. Let it send email when every recipient is at our company domain'
          : 'e.g. Let it request payments up to $5,000'}
        rows={2}
        disabled={busy || !!result}
        data-testid="proxy-rule-description"
      />

      {clarifications.map((c) => (
        <div key={c.question} className="text-xs">
          <p className="text-muted-foreground">{c.question}</p>
          <p className="text-foreground">{c.answer}</p>
        </div>
      ))}

      {question && (
        <div className="space-y-2" data-testid="proxy-rule-question">
          <p className="text-sm text-foreground">{question}</p>
          <div className="flex gap-2">
            <Input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAnswer() }}
              placeholder="Your answer"
              disabled={busy}
              data-testid="proxy-rule-answer"
            />
            <Button size="sm" onClick={submitAnswer} disabled={busy || !answer.trim()}>Answer</Button>
          </div>
        </div>
      )}

      {result && report && (
        <div className="space-y-3" data-testid="proxy-rule-draft">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Name</p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="mt-1"
              disabled={busy}
              data-testid="proxy-rule-name-input"
            />
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What the code does</p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="proxy-rule-effect">
              {result.draft.effect === 'require'
                ? 'Requires review: holds matching requests for review, even ones your permissions allow, unless the code returns true.'
                : 'Skips review: lets matching requests your permissions would review through when the code returns true.'}
            </p>
            <p className="mt-1 text-sm leading-6" data-testid="proxy-rule-restatement">
              {result.restatement || 'No description could be generated — read the code below.'}
            </p>
          </div>
          {report.errors.length > 0 && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs">
              {report.errors.map((e) => <p key={e}>{e}</p>)}
            </div>
          )}
          {report.warnings.length > 0 && <Warnings warnings={report.warnings} />}
          {result.coverage.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {result.coverage.map((c) => <span key={c} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{c}</span>)}
            </div>
          )}
          <ul className="space-y-0.5">
            {report.testResults.map((t) => (
              <li key={t.name} className="flex items-start gap-2 text-xs leading-5">
                {t.passed ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />}
                <span>{t.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{ruleTestExpectLabel(result.draft.effect, t.expect)}</span>
              </li>
            ))}
          </ul>
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-3.5 w-3.5" /> Show code
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] leading-5">{result.draft.code}</pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone} disabled={save.isPending}>Cancel</Button>
        {result ? (
          <>
            <Button size="sm" variant="outline" onClick={() => { setResult(null); setClarifications([]) }} disabled={busy}>
              Start over
            </Button>
            <Button size="sm" onClick={() => save.mutate(result.draft)} disabled={busy || !report?.ok} data-testid="proxy-rule-save">
              {save.isPending ? 'Saving…' : 'Save rule'}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => author.mutate(clarifications)}
            disabled={busy || !description.trim() || !!question}
            data-testid="proxy-rule-write"
          >
            {author.isPending ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Writing…</> : 'Write rule'}
          </Button>
        )}
      </div>
    </div>
  )
}
