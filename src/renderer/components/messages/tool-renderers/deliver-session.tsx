import { ArrowDownToLine, ArrowRight, MessageSquare } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useNavigate } from '@tanstack/react-router'
import { useAgents } from '@renderer/hooks/use-agents'
import { useSession } from '@renderer/hooks/use-sessions'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps, CollapsedContentProps } from './types'
import { deliverSessionDef, shortSessionId, type DeliverSessionInput } from '@shared/lib/tool-definitions/deliver-session'

function useAgentName(slug: string | undefined): string | undefined {
  const { data: agents } = useAgents()
  if (!slug) return undefined
  return agents?.find((a) => a.slug === slug)?.name ?? slug
}

// Resolve session name via the same query the rest of the app uses.
// Falls back to the truncated session ID while the query is in flight or if
// the session is missing/inaccessible.
function useSessionLabel(slug: string | undefined, sessionId: string | undefined): string {
  const { data } = useSession(sessionId ?? null, slug ?? null)
  if (!sessionId) return ''
  return data?.name || shortSessionId(sessionId)
}

function ExpandedView({ input, result, isError, agentSlug }: ToolRendererProps) {
  const { session_id, agent_slug, description } = input as DeliverSessionInput
  const navigate = useNavigate()

  // agent_slug from input wins (x-agent case); fall back to the message's agent
  // (the one running the tool) when omitted — i.e. "deliver one of my own sessions".
  const targetSlug = agent_slug || agentSlug
  const targetName = useAgentName(targetSlug)
  const sessionLabel = useSessionLabel(targetSlug, session_id)

  const handleOpen = () => {
    if (!targetSlug || !session_id) return
    void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: targetSlug, sessionId: session_id } })
  }

  return (
    <div className="space-y-2">
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {session_id && (
        <div className="flex items-center gap-2 flex-wrap">
          <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
          <code className="bg-background px-1.5 py-0.5 rounded text-xs">
            {targetName ? `${targetName} · ${sessionLabel}` : sessionLabel}
          </code>
          {!isError && targetSlug && (
            <Button onClick={handleOpen} size="sm" variant="outline" className="h-7">
              <ArrowRight className="h-3 w-3 mr-1" />
              Open Session
            </Button>
          )}
        </div>
      )}
      {result && (
        <div
          className={`bg-background text-xs rounded p-2 ${isError ? 'text-red-800 dark:text-red-200' : 'text-green-800 dark:text-green-200'}`}
        >
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </div>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  try {
    const partial = JSON.parse(partialInput)
    if (partial.session_id) {
      return (
        <div className="text-xs text-muted-foreground">
          Delivering session: {shortSessionId(partial.session_id)}
        </div>
      )
    }
  } catch {
    // partial JSON, ignore
  }
  return <div className="text-xs text-muted-foreground">Preparing session…</div>
}

function CollapsedContent({ input, isError, agentSlug }: CollapsedContentProps) {
  const { session_id, agent_slug } = input as DeliverSessionInput
  const targetSlug = agent_slug || agentSlug
  const targetName = useAgentName(targetSlug)
  const sessionLabel = useSessionLabel(targetSlug, session_id)
  const navigate = useNavigate()

  if (!session_id || !targetSlug || isError) return null

  const label = targetName ? `${targetName} · ${sessionLabel}` : sessionLabel

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: targetSlug, sessionId: session_id } })
      }}
      className="inline-flex min-w-0 max-w-full items-center gap-1 px-2 py-0.5 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted whitespace-nowrap"
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      <ArrowRight className="h-3 w-3 shrink-0" />
    </button>
  )
}

export const deliverSessionRenderer: ToolRenderer = {
  displayName: 'Deliver Session',
  icon: ArrowDownToLine,
  getSummary: (input: unknown) => deliverSessionDef.getSummary(input),
  ExpandedView,
  StreamingView,
  CollapsedContent,
}
