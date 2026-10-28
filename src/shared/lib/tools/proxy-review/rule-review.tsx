import { apiFetch } from '@renderer/lib/api'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronRight, ShieldCheck, ShieldX, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { cn } from '@shared/lib/utils/cn'
import {
  ruleEffectLabel,
  ruleTestExpectLabel,
  type ReviewRuleOutcomeView,
  type RuleProposalReview,
} from '@shared/lib/proxy/rules/proposal-schema'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'

function outcomeText(outcome: ReviewRuleOutcomeView): string {
  const require = outcome.effect === 'require'
  switch (outcome.result) {
    case 'false': return require ? 'requires review for this' : "didn't allow it"
    case 'threw': return `failed: ${outcome.detail ?? 'error'}`
    case 'timeout': return 'timed out'
    case 'non_boolean': return `returned a ${outcome.detail ?? 'non-boolean'} value`
    case 'invalid_code': return `could not run: ${outcome.detail ?? 'invalid code'}`
    case 'schema_changed': return require
      ? 'holds it: the tool changed since the rule was approved'
      : 'skipped: the tool changed since the rule was approved'
    case 'true': return require ? 'passed' : 'allowed it'
    default: return outcome.result
  }
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text
}

/** Rules that ran on a reviewed request: the require rule that held it, or
 * the allow rules that didn't let it through. */
export function RuleOutcomesList({ outcomes }: { outcomes: ReviewRuleOutcomeView[] }) {
  return (
    <div className="mt-2 space-y-1" data-testid="proxy-review-rule-outcomes">
      {outcomes.map((outcome) => (
        <p key={`${outcome.ruleId}-${outcome.version}`} className="text-xs leading-5 text-muted-foreground">
          Rule{' '}
          <span className="font-medium text-foreground/80" title={outcome.restatement || undefined}>
            {outcome.name || shorten(outcome.restatement) || 'Untitled rule'}
          </span>{' '}
          {outcomeText(outcome)}.
        </p>
      ))}
    </div>
  )
}

interface RuleProposalRequestItemProps {
  reviewId: string
  agentSlug: string
  displayText?: string
  proposal: RuleProposalReview
  sessionId?: string
  readOnly?: boolean
  onComplete: () => void
}

type Status = 'pending' | 'submitting' | 'allowed' | 'denied'

/**
 * Confirmation card for a proxy rule an agent proposed. Leads with the
 * description the host generated from the code alone; the agent's own words
 * are shown second and labelled as such.
 */
export function RuleProposalRequestItem({
  reviewId,
  agentSlug,
  displayText,
  proposal,
  sessionId,
  readOnly,
  onComplete,
}: RuleProposalRequestItemProps) {
  const [status, setStatus] = useState<Status>('pending')
  const [error, setError] = useState<string | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const decide = async (decision: 'allow' | 'deny') => {
    setStatus('submitting')
    setError(null)
    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/proxy-review/${reviewId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (!response.ok && response.status !== 404) {
        const data = await response.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error || 'Failed to submit decision')
      }
      setStatus(decision === 'allow' ? 'allowed' : 'denied')
      timer.current = setTimeout(onComplete, response.ok ? 2000 : 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit decision')
      setStatus('pending')
    }
  }

  const effectText = proposal.effect === 'require'
    ? 'Holds matching requests for review, even ones your policy allows, unless the code returns true.'
    : 'Lets matching requests your policy would review through when the code returns true.'
  const deleting = !!proposal.deletesRuleId
  const title = displayText || (deleting
    ? `Delete rule “${proposal.name ?? 'Untitled'}” on ${proposal.targetName}?`
    : proposal.name ? `Add rule “${proposal.name}” on ${proposal.targetName}?` : `Add a rule for ${proposal.targetName}?`)
  const isCompleted = status === 'allowed' || status === 'denied'
  const failed = proposal.tests.filter((t) => !t.passed).length

  return (
    <RequestItemShell
      title={title}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      completed={isCompleted ? {
        icon: status === 'allowed'
          ? <ShieldCheck className="h-4 w-4 shrink-0 text-green-500" />
          : <ShieldX className="h-4 w-4 shrink-0 text-red-500" />,
        label: <span className="font-medium">{proposal.name ? `Rule “${proposal.name}”` : `Rule for ${proposal.targetName}`}</span>,
        statusLabel: deleting
          ? (status === 'allowed' ? 'Deleted' : 'Kept')
          : (status === 'allowed' ? 'Added' : 'Rejected'),
        isSuccess: status === 'allowed',
      } : null}
      readOnly={readOnly ? { extraContent: <p className="mt-2 text-sm text-foreground/80">{proposal.restatement}</p> } : false}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'rule-proposal-completed' : 'rule-proposal-request'}
      data-review-id={reviewId}
    >
      <div className="mt-3 space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 font-medium text-foreground/80">{proposal.targetName}</span>
          <span className="inline-flex h-6 items-center rounded-md border px-2 font-medium text-foreground/80" data-testid="rule-proposal-effect">
            {ruleEffectLabel(proposal.effect)}
          </span>
          <span>{proposal.appliesTo === 'agent' ? 'Applies to this agent only' : 'Applies to every agent using this connection'}</span>
          {proposal.replacesRuleId && <span>· Replaces an existing rule</span>}
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {deleting ? 'What the rule does today' : 'What the code does'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{effectText}</p>
          <p className="mt-1 leading-6 text-foreground" data-testid="rule-proposal-restatement">
            {proposal.restatement || 'No independent description could be generated — read the code below before approving.'}
          </p>
        </div>

        {!deleting && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">The agent&rsquo;s description</p>
            <p className="mt-1 leading-6 text-foreground/80">{proposal.description}</p>
          </div>
        )}

        {proposal.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2" data-testid="rule-proposal-warnings">
            {proposal.warnings.map((warning) => (
              <p key={warning} className="flex gap-2 text-xs leading-5 text-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>{warning}</span>
              </p>
            ))}
          </div>
        )}

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Requests it covers</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {(proposal.coverage.length > 0 ? proposal.coverage : proposal.patterns).map((entry) => (
              <span key={entry} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{entry}</span>
            ))}
          </div>
        </div>

        {proposal.tests.length > 0 && <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Test cases ({proposal.tests.length - failed}/{proposal.tests.length} pass)
          </p>
          <ul className="mt-1 space-y-0.5">
            {proposal.tests.map((test) => (
              <li key={test.name} className="flex items-start gap-2 text-xs leading-5">
                {test.passed
                  ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
                  : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />}
                <span className="text-foreground/85">{test.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{ruleTestExpectLabel(proposal.effect, test.expect)}</span>
              </li>
            ))}
          </ul>
        </div>}

        <Collapsible open={codeOpen} onOpenChange={setCodeOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', codeOpen && 'rotate-90')} />
            Show code
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-[11px] leading-5">{proposal.code}</pre>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <RequestItemActions>
        <Button
          data-testid="rule-proposal-reject-btn"
          onClick={() => decide('deny')}
          disabled={status === 'submitting'}
          size="xs"
          variant="outline"
          className="border-border text-foreground hover:bg-muted"
        >
          {deleting ? 'Keep rule' : 'Reject'}
        </Button>
        <Button
          data-testid="rule-proposal-approve-btn"
          onClick={() => decide('allow')}
          disabled={status === 'submitting'}
          size="xs"
          className="bg-orange-600 text-white hover:bg-orange-700"
        >
          {deleting ? 'Delete rule' : 'Add rule'}
        </Button>
      </RequestItemActions>
    </RequestItemShell>
  )
}
