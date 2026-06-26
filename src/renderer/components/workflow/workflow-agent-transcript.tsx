import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { ToolCallItem } from '@renderer/components/messages/tool-call-item'
import type { ApiMessage, ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'

type FlatItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; toolCall: ApiToolCall; messageCreatedAt: Date | string }

/**
 * Renders one workflow subagent's transcript at the same fidelity as a regular
 * subagent: assistant text blocks (markdown) + tool calls, flattened in order.
 * Mirrors the flatten/render logic of `subagent-block.tsx` (the workflow agents
 * emit no sidechain stream, so their live content comes from the polled transcript
 * rather than streaming deltas — hence this is the simpler, read-only variant).
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
  const flatItems = useMemo<FlatItem[]>(() => {
    const assistantMessages = messages?.filter((m): m is ApiMessage => m.type === 'assistant') ?? []
    const items: FlatItem[] = []
    for (const msg of assistantMessages) {
      if (msg.content.text) items.push({ kind: 'text', key: `text-${msg.id}`, text: msg.content.text })
      for (const tc of msg.toolCalls ?? []) {
        items.push({ kind: 'tool', key: `tool-${tc.id}`, toolCall: tc, messageCreatedAt: msg.createdAt })
      }
    }
    return items
  }, [messages])

  if (flatItems.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-2">
        {isRunning ? 'Agent is working…' : 'No activity recorded.'}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {flatItems.map((item) =>
        item.kind === 'text' ? (
          <div key={item.key} className="prose prose-sm max-w-none break-words dark:prose-invert text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
              {item.text}
            </ReactMarkdown>
          </div>
        ) : (
          <ToolCallItem
            key={item.key}
            toolCall={item.toolCall}
            messageCreatedAt={item.messageCreatedAt}
            agentSlug={agentSlug}
            // While the agent is running, an in-flight tool (no result yet) must show the
            // running spinner — without this it renders as the "cancelled" icon.
            isSessionActive={isRunning}
          />
        )
      )}
    </div>
  )
}
