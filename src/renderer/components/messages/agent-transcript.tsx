import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { ToolCallItem } from './tool-call-item'
import type { ApiMessage, ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'

/**
 * Shared rendering for an agent's transcript — the assistant text + tool-call stream
 * an agent produces. Used by both the sub-agent block (`subagent-block.tsx`) and the
 * dynamic-workflow per-agent drawer (`workflow/workflow-agent-transcript.tsx`) so the
 * two render identically; the callers add their own chrome (header, streaming deltas,
 * collapse, result footer) around these primitives.
 */

/** One renderable unit of a transcript: a markdown text block or a tool call. */
export type FlatItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; toolCall: ApiToolCall; messageCreatedAt: Date | string }

/**
 * Flatten messages into ordered transcript items: each assistant message contributes
 * its text block (when non-empty) followed by its tool calls, in order. Non-assistant
 * entries (user/boundary) are skipped.
 */
export function flattenAssistantMessages(messages: ApiMessageOrBoundary[] | undefined): FlatItem[] {
  const assistantMessages = messages?.filter((m): m is ApiMessage => m.type === 'assistant') ?? []
  const items: FlatItem[] = []
  for (const msg of assistantMessages) {
    if (msg.content.text) items.push({ kind: 'text', key: `text-${msg.id}`, text: msg.content.text })
    for (const tc of msg.toolCalls ?? []) {
      items.push({ kind: 'tool', key: `tool-${tc.id}`, toolCall: tc, messageCreatedAt: msg.createdAt })
    }
  }
  return items
}

/** A markdown text block styled for a transcript (prose, xs). */
export function TranscriptText({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

/**
 * Render a list of flat transcript items (text blocks + tool calls) as a fragment, so
 * the caller controls the surrounding container/spacing. `isSessionActive` is forwarded
 * to each ToolCallItem so an in-flight tool shows the running spinner (not the cancelled
 * icon).
 */
export function TranscriptItems({
  items,
  agentSlug,
  isSessionActive,
}: {
  items: FlatItem[]
  agentSlug: string
  isSessionActive?: boolean
}) {
  return (
    <>
      {items.map((item) =>
        item.kind === 'text' ? (
          <TranscriptText key={item.key}>{item.text}</TranscriptText>
        ) : (
          <ToolCallItem
            key={item.key}
            toolCall={item.toolCall}
            messageCreatedAt={item.messageCreatedAt}
            agentSlug={agentSlug}
            isSessionActive={isSessionActive}
          />
        )
      )}
    </>
  )
}
