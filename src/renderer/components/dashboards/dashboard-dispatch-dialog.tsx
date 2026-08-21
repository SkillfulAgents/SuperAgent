import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import {
  DASHBOARD_DISPATCH_CONSENT_PREFIX,
  DASHBOARD_DISPATCH_CONSENT_SUFFIX,
  type DashboardDispatchResult,
} from '@shared/lib/dashboard-dispatch-schema'
import type { PendingDashboardDispatch } from './use-dashboard-dispatch'

interface DashboardDispatchDialogProps {
  request: PendingDashboardDispatch | null
  /** Canonical slug of the agent that owns the dashboard — sessions always run on it. */
  dashboardAgentSlug: string
  /** Display name for the owning agent; falls back to the slug. */
  dashboardAgentName?: string
  dashboardSlug: string
  onResolve: (result: DashboardDispatchResult) => void
}

/**
 * App-controlled confirmation for dashboard-initiated session dispatch: the
 * dashboard only proposes a prompt; nothing runs until the user reviews
 * (and optionally edits) it here and clicks Dispatch. The session always runs
 * on the dashboard's owning agent — prompts are usually agent-local slash
 * commands, so there is deliberately no agent picker.
 */
export function DashboardDispatchDialog({
  request,
  dashboardAgentSlug,
  dashboardAgentName,
  dashboardSlug,
  onResolve,
}: DashboardDispatchDialogProps) {
  // While the create request is in flight, every dismissal path (Escape,
  // outside click, the X button) funnels through onOpenChange — ignoring it
  // keeps the controlled dialog open, so the dashboard can't be told
  // "cancelled" while a real session gets created.
  const dispatchingRef = useRef(false)
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !dispatchingRef.current) onResolve({ cancelled: true })
      }}
    >
      {request && (
        <DispatchDialogContent
          key={request.id}
          request={request}
          dashboardAgentSlug={dashboardAgentSlug}
          dashboardAgentName={dashboardAgentName}
          dashboardSlug={dashboardSlug}
          onResolve={onResolve}
          dispatchingRef={dispatchingRef}
        />
      )}
    </Dialog>
  )
}

function DispatchDialogContent({
  request,
  dashboardAgentSlug,
  dashboardAgentName,
  dashboardSlug,
  onResolve,
  dispatchingRef,
}: DashboardDispatchDialogProps & {
  request: PendingDashboardDispatch
  dispatchingRef: MutableRefObject<boolean>
}) {
  const createSession = useCreateSession()
  const [prompt, setPrompt] = useState(request.prompt)
  const [error, setError] = useState<string | null>(null)

  const handleDispatch = useCallback(async () => {
    const message = prompt.trim()
    if (!message) return
    setError(null)
    dispatchingRef.current = true
    try {
      const session = await createSession.mutateAsync({
        agentSlug: dashboardAgentSlug,
        message,
        dashboardDispatch: { dashboardSlug },
      })
      onResolve({ sessionId: session.id, agentSlug: dashboardAgentSlug })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      dispatchingRef.current = false
    }
  }, [prompt, createSession, dashboardAgentSlug, dashboardSlug, onResolve, dispatchingRef])

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{request.title || 'Dispatch agent session'}</DialogTitle>
        {/* Consent sentence shared with the /view wrapper's dialog so the two
            surfaces can never show divergent consent language. */}
        <DialogDescription>
          {DASHBOARD_DISPATCH_CONSENT_PREFIX}
          <span className="font-medium text-foreground">{dashboardAgentName || dashboardAgentSlug}</span>
          {DASHBOARD_DISPATCH_CONSENT_SUFFIX}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 py-2">
        <Label htmlFor="dashboard-dispatch-prompt">Prompt</Label>
        <Textarea
          id="dashboard-dispatch-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="max-h-64"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button
          variant="outline"
          disabled={createSession.isPending}
          onClick={() => onResolve({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button onClick={handleDispatch} disabled={createSession.isPending || !prompt.trim()}>
          <Send className="mr-2 h-4 w-4" />
          {createSession.isPending ? 'Dispatching…' : 'Dispatch'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
