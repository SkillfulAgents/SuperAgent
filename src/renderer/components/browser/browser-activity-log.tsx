import { useMemo, useEffect, useRef, useState } from 'react'
import { Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { useMessages, useSubagentMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { getToolRenderer } from '@renderer/components/messages/tool-renderers'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import { cn } from '@shared/lib/utils/cn'
import type { ApiMessage, ApiToolCall } from '@shared/lib/types/api'

const BROWSER_TOOL_PREFIX = 'mcp__browser__'
const MAX_ENTRIES = 80

type FlatItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; toolCall: ApiToolCall }

interface BrowserActivityLogProps {
  sessionId: string
  agentSlug: string
}

export function BrowserActivityLog({ sessionId, agentSlug }: BrowserActivityLogProps) {
  const { data: messages } = useMessages(sessionId, agentSlug)
  const { streamingToolUse, activeSubagents } = useMessageStream(sessionId, agentSlug)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Find the browser subagent ID
  const subagentId = useMemo(() => {
    for (const sub of activeSubagents ?? []) {
      if (sub.agentId && sub.streamingToolUse?.name.startsWith(BROWSER_TOOL_PREFIX)) {
        return sub.agentId
      }
    }
    if (!messages) return null
    let lastSubagentId: string | null = null
    for (const msg of messages) {
      if (msg.type !== 'assistant') continue
      const apiMsg = msg as ApiMessage
      if (!apiMsg.toolCalls) continue
      for (const tc of apiMsg.toolCalls) {
        if ((tc.name === 'Task' || tc.name === 'Agent') && tc.subagent?.agentId) {
          lastSubagentId = tc.subagent.agentId
        }
      }
    }
    return lastSubagentId
  }, [messages, activeSubagents])

  const { data: subMessages } = useSubagentMessages(sessionId, agentSlug, subagentId)

  // Flatten subagent messages into interleaved text + tool call items
  const flatItems = useMemo(() => {
    const items: FlatItem[] = []

    const processMessages = (msgs: typeof messages) => {
      if (!msgs) return
      for (const msg of msgs) {
        if (msg.type !== 'assistant') continue
        const apiMsg = msg as ApiMessage
        if (apiMsg.content.text) {
          items.push({ kind: 'text', key: `text-${apiMsg.id}`, text: apiMsg.content.text })
        }
        for (const tc of apiMsg.toolCalls ?? []) {
          if (tc.name.startsWith(BROWSER_TOOL_PREFIX)) {
            items.push({ kind: 'tool', key: `tool-${tc.id}`, toolCall: tc })
          }
        }
      }
    }

    processMessages(subMessages)

    if (messages) {
      for (const msg of messages) {
        if (msg.type !== 'assistant') continue
        const apiMsg = msg as ApiMessage
        if (!apiMsg.toolCalls) continue
        for (const tc of apiMsg.toolCalls) {
          if (tc.name.startsWith(BROWSER_TOOL_PREFIX)) {
            const exists = items.some(i => i.kind === 'tool' && i.toolCall.id === tc.id)
            if (!exists) {
              items.push({ kind: 'tool', key: `tool-${tc.id}`, toolCall: tc })
            }
          }
        }
      }
    }

    return items.slice(-MAX_ENTRIES)
  }, [messages, subMessages])

  // Streaming browser tool
  const streamingBrowserTool = useMemo(() => {
    if (streamingToolUse?.name.startsWith(BROWSER_TOOL_PREFIX)) {
      const persisted = flatItems.some(i => i.kind === 'tool' && i.toolCall.id === streamingToolUse.id)
      if (!persisted) return streamingToolUse
    }
    for (const sub of activeSubagents ?? []) {
      if (sub.streamingToolUse?.name.startsWith(BROWSER_TOOL_PREFIX)) {
        const persisted = flatItems.some(i => i.kind === 'tool' && i.toolCall.id === sub.streamingToolUse!.id)
        if (!persisted) return sub.streamingToolUse
      }
    }
    return null
  }, [streamingToolUse, activeSubagents, flatItems])

  // Streaming assistant text from subagent
  const streamingText = useMemo(() => {
    for (const sub of activeSubagents ?? []) {
      if (sub.streamingMessage) {
        const lastTextItem = [...flatItems].reverse().find(i => i.kind === 'text')
        if (lastTextItem && lastTextItem.kind === 'text') {
          const persisted = lastTextItem.text.trim()
          const streaming = sub.streamingMessage.trim()
          if (persisted.startsWith(streaming) || streaming.startsWith(persisted)) {
            return null
          }
        }
        return sub.streamingMessage
      }
    }
    return null
  }, [activeSubagents, flatItems])

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [flatItems.length, streamingBrowserTool, streamingText])

  if (flatItems.length === 0 && !streamingBrowserTool && !streamingText) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center px-4 py-4">
        <span className="text-xs text-muted-foreground">No browser activity yet</span>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div ref={scrollRef} className="px-4 py-2 space-y-2.5">
        {flatItems.map((item) =>
          item.kind === 'text' ? (
            <p key={item.key} className="text-[11px] leading-normal text-muted-foreground">
              {item.text}
            </p>
          ) : (
            <CompactToolCall key={item.key} toolCall={item.toolCall} />
          )
        )}
        {streamingText && (
          <p className="text-[11px] leading-normal text-muted-foreground animate-pulse">
            {streamingText}
          </p>
        )}
        {streamingBrowserTool && (
          <CompactStreamingTool name={streamingBrowserTool.name} partialInput={streamingBrowserTool.partialInput} />
        )}
      </div>
    </ScrollArea>
  )
}

function CompactToolCall({ toolCall }: { toolCall: ApiToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const renderer = getToolRenderer(toolCall.name)
  const Icon = renderer?.icon
  const summary = renderer?.getSummary?.(toolCall.input)
  const parsed = parseToolResult(toolCall.result)
  const hasDetail = !!(parsed.text || toolCall.input)

  const isError = toolCall.isError

  return (
    <div className="text-[11px] rounded-md border border-border/30 px-2 py-1">
      <button
        className={cn(
          'w-full flex items-center gap-1 rounded-sm',
          hasDetail && 'hover:bg-muted/50'
        )}
        onClick={() => hasDetail && setExpanded(!expanded)}
      >
        {Icon && <Icon className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />}
        <span className="font-medium text-foreground/80 shrink-0">
          {renderer?.displayName ?? toolCall.name.replace(BROWSER_TOOL_PREFIX, '')}
        </span>
        {summary && (
          <span className="text-muted-foreground/60 truncate min-w-0">{summary}</span>
        )}
        {hasDetail && (
          <span className="ml-auto shrink-0">
            {expanded ? (
              <ChevronDown className="h-2.5 w-2.5 text-muted-foreground/40" />
            ) : (
              <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/40" />
            )}
          </span>
        )}
      </button>
      {expanded && parsed.text && (
        <pre className={cn(
          'ml-5 mt-0.5 mb-1 text-[10px] leading-snug whitespace-pre-wrap break-words rounded p-1.5 max-h-32 overflow-y-auto',
          isError
            ? 'bg-red-50/50 text-red-700/70 dark:bg-red-950/30 dark:text-red-300/70'
            : 'bg-muted/30 text-muted-foreground/70'
        )}>
          {parsed.text}
        </pre>
      )}
    </div>
  )
}

function CompactStreamingTool({ name, partialInput }: { name: string; partialInput: string }) {
  const renderer = getToolRenderer(name)
  const Icon = renderer?.icon
  let summary: string | null = null
  if (renderer?.getSummary) {
    try {
      summary = renderer.getSummary(JSON.parse(partialInput))
    } catch { /* partial json */ }
  }

  return (
    <div className="flex items-center gap-1 py-0.5 text-[11px]">
      <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-muted-foreground" />
      {Icon && <Icon className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />}
      <span className="font-medium text-foreground/80 shrink-0">
        {renderer?.displayName ?? name.replace(BROWSER_TOOL_PREFIX, '')}
      </span>
      {summary && (
        <span className="text-muted-foreground/60 truncate min-w-0">{summary}</span>
      )}
    </div>
  )
}
