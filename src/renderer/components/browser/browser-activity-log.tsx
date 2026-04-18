import { useMemo, useEffect, useRef, useState } from 'react'
import { Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { useMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useQueries } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { getToolRenderer } from '@renderer/components/messages/tool-renderers'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import { cn } from '@shared/lib/utils/cn'
import type { ApiMessage, ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'

const BROWSER_TOOL_PREFIX = 'mcp__browser__'
const MAX_ENTRIES = 80

interface FlatItem {
  kind: 'tool'
  key: string
  toolCall: ApiToolCall
}

interface BrowserActivityLogProps {
  sessionId: string
  agentSlug: string
}

export function BrowserActivityLog({ sessionId, agentSlug }: BrowserActivityLogProps) {
  const { data: messages } = useMessages(sessionId, agentSlug)
  const { streamingToolUse, activeSubagents } = useMessageStream(sessionId, agentSlug)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)

  // Collect ALL subagent IDs from the session messages
  const subagentIds = useMemo(() => {
    if (!messages) return []
    const ids: string[] = []
    for (const msg of messages) {
      if (msg.type !== 'assistant') continue
      const apiMsg = msg as ApiMessage
      if (!apiMsg.toolCalls) continue
      for (const tc of apiMsg.toolCalls) {
        if ((tc.name === 'Task' || tc.name === 'Agent') && tc.subagent?.agentId) {
          ids.push(tc.subagent.agentId)
        }
      }
    }
    return ids
  }, [messages])

  // Fetch messages for ALL subagents in parallel
  const subagentQueries = useQueries({
    queries: subagentIds.map((subId) => ({
      queryKey: ['subagent-messages', sessionId, agentSlug, subId],
      queryFn: async () => {
        const res = await apiFetch(
          `/api/agents/${agentSlug}/sessions/${sessionId}/subagent/${subId}/messages`
        )
        if (!res.ok) throw new Error('Failed to fetch subagent messages')
        return res.json() as Promise<ApiMessageOrBoundary[]>
      },
      refetchInterval: false as const,
    })),
  })

  // Extract browser tool calls from all sources, deduplicated and in message order
  const flatItems = useMemo(() => {
    const seen = new Set<string>()
    const items: FlatItem[] = []

    const extractBrowserTools = (msgs: ApiMessageOrBoundary[] | undefined) => {
      if (!msgs) return
      for (const msg of msgs) {
        if (msg.type !== 'assistant') continue
        const apiMsg = msg as ApiMessage
        for (const tc of apiMsg.toolCalls ?? []) {
          if (tc.name.startsWith(BROWSER_TOOL_PREFIX) && !seen.has(tc.id)) {
            seen.add(tc.id)
            items.push({ kind: 'tool', key: `tool-${tc.id}`, toolCall: tc })
          }
        }
      }
    }

    // Process main messages first (they're in chronological order)
    extractBrowserTools(messages)

    // Then add any browser tools from subagents that aren't already included
    for (const query of subagentQueries) {
      extractBrowserTools(query.data)
    }

    return items.slice(-MAX_ENTRIES)
  }, [messages, subagentQueries])

  // Streaming browser tool (from active subagent or main agent)
  const streamingBrowserTool = useMemo(() => {
    if (streamingToolUse?.name.startsWith(BROWSER_TOOL_PREFIX)) {
      const persisted = flatItems.some(i => i.toolCall.id === streamingToolUse.id)
      if (!persisted) return streamingToolUse
    }
    for (const sub of activeSubagents ?? []) {
      if (sub.streamingToolUse?.name.startsWith(BROWSER_TOOL_PREFIX)) {
        const persisted = flatItems.some(i => i.toolCall.id === sub.streamingToolUse!.id)
        if (!persisted) return sub.streamingToolUse
      }
    }
    return null
  }, [streamingToolUse, activeSubagents, flatItems])

  useEffect(() => {
    bottomSentinelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [flatItems.length, streamingBrowserTool])

  if (flatItems.length === 0 && !streamingBrowserTool) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center px-4 py-4">
        <span className="text-xs text-muted-foreground">No browser activity yet</span>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="px-4 py-2 space-y-2.5">
        {flatItems.map((item) => (
          <CompactToolCall key={item.key} toolCall={item.toolCall} />
        ))}
        {streamingBrowserTool && (
          <CompactStreamingTool name={streamingBrowserTool.name} partialInput={streamingBrowserTool.partialInput} />
        )}
        <div ref={bottomSentinelRef} />
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
    <div className="text-xs rounded-md border border-border/30 px-2 py-1">
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
          'ml-5 mt-0.5 mb-1 text-2xs leading-snug whitespace-pre-wrap break-words rounded p-1.5 max-h-32 overflow-y-auto',
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
    <div className="flex items-center gap-1 py-0.5 text-xs">
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
