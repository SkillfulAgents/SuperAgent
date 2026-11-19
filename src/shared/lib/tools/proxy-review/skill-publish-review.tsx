import { apiFetch } from '@renderer/lib/api'
import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, ShieldX } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import type { SkillPublishReview } from '@shared/lib/proxy/skill-publish-review'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'

interface SkillPublishRequestItemProps {
  reviewId: string
  agentSlug: string
  displayText?: string
  publish: SkillPublishReview
  sessionId?: string
  readOnly?: boolean
  onComplete: () => void
}

type Status = 'pending' | 'submitting' | 'allowed' | 'denied'

/**
 * Approval card for a skill an agent asks to publish to a team skillset. The description and
 * the file list are read by the host; the agent's own words are shown second and labelled.
 */
export function SkillPublishRequestItem({
  reviewId,
  agentSlug,
  displayText,
  publish,
  sessionId,
  readOnly,
  onComplete,
}: SkillPublishRequestItemProps) {
  const [status, setStatus] = useState<Status>('pending')
  const [error, setError] = useState<string | null>(null)
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

  const title = displayText || (publish.updatesPublishedSkill
    ? `Update skill “${publish.skillName}” in ${publish.skillsetName}?`
    : `Publish skill “${publish.skillName}” to ${publish.skillsetName}?`)
  const isCompleted = status === 'allowed' || status === 'denied'

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
        label: <span className="font-medium">{`Skill “${publish.skillName}”`}</span>,
        statusLabel: status === 'allowed' ? 'Approved' : 'Rejected',
        isSuccess: status === 'allowed',
      } : null}
      readOnly={readOnly ? { extraContent: <p className="mt-2 text-sm text-foreground/80">{publish.description}</p> } : false}
      waitingText="Waiting for approval"
      error={error}
      data-testid={isCompleted ? 'skill-publish-completed' : 'skill-publish-request'}
      data-review-id={reviewId}
    >
      <div className="mt-3 space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex h-6 items-center rounded-control bg-muted px-2 font-medium text-foreground/80">{publish.skillsetName}</span>
          <span className="inline-flex h-6 items-center rounded-control border px-2 font-medium text-foreground/80" data-testid="skill-publish-kind">
            {publish.updatesPublishedSkill ? 'Updates a published skill' : 'New skill'}
          </span>
          <span>Every agent in your team can install it</span>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What the skill does</p>
          <p className="mt-1 leading-6 text-foreground" data-testid="skill-publish-description">{publish.description}</p>
        </div>

        {publish.agentNote && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">The agent&rsquo;s note</p>
            <p className="mt-1 leading-6 text-foreground/80">{publish.agentNote}</p>
          </div>
        )}

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files ({publish.files.length})</p>
          <div className="mt-1 flex flex-wrap gap-1" data-testid="skill-publish-files">
            {publish.files.map((file) => (
              <span key={file} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{file}</span>
            ))}
          </div>
        </div>
      </div>

      <RequestItemActions>
        <Button
          data-testid="skill-publish-reject-btn"
          onClick={() => decide('deny')}
          disabled={status === 'submitting'}
          size="xs"
          variant="outline"
          className="border-border text-foreground hover:bg-muted"
        >
          Reject
        </Button>
        <Button
          data-testid="skill-publish-approve-btn"
          onClick={() => decide('allow')}
          disabled={status === 'submitting'}
          size="xs"
          className="bg-orange-600 text-white hover:bg-orange-700"
        >
          Publish
        </Button>
      </RequestItemActions>
    </RequestItemShell>
  )
}
