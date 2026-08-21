import { useMemo } from 'react'
import { flattenAssistantMessages, TranscriptItems } from '@renderer/components/messages/agent-transcript'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

/**
 * Renders one workflow subagent's transcript at the same fidelity as a regular
 * subagent, via the shared {@link TranscriptItems}. The workflow agents emit no
 * sidechain stream, so their content comes from the polled transcript rather than
 * streaming deltas — hence this is the simpler, read-only variant (no streaming /
 * collapse / result chrome that `subagent-block.tsx` layers on top).
 */
export function WorkflowAgentTranscript({
  messages,
  agentSlug,
  isRunning,
}: {
  messages: ApiMessageOrBoundary[] | undefined
  agentSlug: string
  isRunning: boolean
}) {
  const flatItems = useMemo(() => flattenAssistantMessages(messages), [messages])

  if (flatItems.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-2">
        {isRunning ? 'Agent is working…' : 'No activity recorded.'}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* While the agent runs, an in-flight tool (no result yet) must show the running
          spinner — without isSessionActive it renders as the "cancelled" icon. */}
      <TranscriptItems items={flatItems} agentSlug={agentSlug} isSessionActive={isRunning} />
    </div>
  )
}
