import { memo, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import { ScrollArea } from '@renderer/components/ui/scroll-area'
import { useMessages, useSubagentMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { getToolRenderer } from '@shared/lib/tools/renderers'
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

interface StreamingTool {
  id: string
  name: string
  partialInput: string
}

const NO_STREAMING_TOOLS: StreamingTool[] = []

interface BrowserActivityLogProps {
  sessionId: string
  agentSlug: string
}

/** What one subagent's transcript gives the log: its loaded messages, and its older pages. */
interface SubagentTranscript {
  messages: ApiMessageOrBoundary[] | undefined
  hasOlder: boolean
  fetchOlder: () => Promise<boolean>
}

type SubagentTranscripts = Readonly<Record<string, SubagentTranscript>>

const NO_SUBAGENT_TRANSCRIPTS: SubagentTranscripts = {}

export function BrowserActivityLog({ sessionId, agentSlug }: BrowserActivityLogProps) {
  const { data: messages } = useMessages(sessionId, agentSlug)
  // Reported by StreamingBrowserToolsWatcher, which takes the stream's
  // per-token re-renders in this component's place.
  const [streamingBrowserTools, setStreamingBrowserTools] = useState(NO_STREAMING_TOOLS)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)

  // Collect ALL subagent IDs from the session messages
  const subagentIds = useMemo(() => {
    if (!messages) return []
    const ids = new Set<string>()
    for (const msg of messages) {
      if (msg.type !== 'assistant') continue
      const apiMsg = msg as ApiMessage
      if (!apiMsg.toolCalls) continue
      for (const tc of apiMsg.toolCalls) {
        if ((tc.name === 'Task' || tc.name === 'Agent') && tc.subagent?.agentId) {
          ids.add(tc.subagent.agentId)
        }
      }
    }
    return [...ids]
  }, [messages])

  // Reported by one SubagentTranscriptWatcher per subagent: the same
  // transcripts the subagent cards read, refreshed with deltas.
  const [subagentTranscripts, setSubagentTranscripts] = useState(NO_SUBAGENT_TRANSCRIPTS)
  const reportSubagentTranscript = useCallback((subagentId: string, transcript: SubagentTranscript | undefined) => {
    setSubagentTranscripts((current) => {
      const next = { ...current }
      if (transcript) next[subagentId] = transcript
      else delete next[subagentId]
      return next
    })
  }, [])
  const transcripts = useMemo(
    () => subagentIds.map((subId) => subagentTranscripts[subId]?.messages),
    [subagentIds, subagentTranscripts],
  )

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
    for (const transcript of transcripts) {
      extractBrowserTools(transcript)
    }

    return items.slice(-MAX_ENTRIES)
  }, [messages, transcripts])

  // Earlier activity can still fit under the cap only while the log is short of it.
  const olderTranscripts = flatItems.length < MAX_ENTRIES
    ? subagentIds.map((subId) => subagentTranscripts[subId]).filter((transcript) => transcript?.hasOlder)
    : []
  const showEarlier = () => {
    for (const transcript of olderTranscripts) void transcript?.fetchOlder()
  }

  // Streaming browser tool (from active subagent or main agent)
  const streamingBrowserTool = useMemo(() => {
    for (const tool of streamingBrowserTools) {
      const persisted = flatItems.some(i => i.toolCall.id === tool.id)
      if (!persisted) return tool
    }
    return null
  }, [streamingBrowserTools, flatItems])

  // By id: the tool's object is replaced with every delta of its input, and
  // each replacement would start another smooth scroll.
  const streamingBrowserToolId = streamingBrowserTool?.id
  useEffect(() => {
    bottomSentinelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [flatItems.length, streamingBrowserToolId])

  // One position for the watcher in both states below: remounting it would drop what it last reported.
  return (
    <>
      <StreamingBrowserToolsWatcher sessionId={sessionId} agentSlug={agentSlug} onChange={setStreamingBrowserTools} />
      {subagentIds.map((subId) => (
        <SubagentTranscriptWatcher
          key={subId}
          sessionId={sessionId}
          agentSlug={agentSlug}
          subagentId={subId}
          onChange={reportSubagentTranscript}
        />
      ))}
      {flatItems.length === 0 && !streamingBrowserTool && olderTranscripts.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center px-4 py-4">
          <span className="text-xs text-muted-foreground">No browser activity yet</span>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 py-2 space-y-2.5">
            {olderTranscripts.length > 0 && (
              <button
                type="button"
                onClick={showEarlier}
                className="text-xs text-foreground hover:text-foreground/70 font-medium transition-colors py-1"
              >
                Show earlier activity
              </button>
            )}
            {flatItems.map((item) => (
              <CompactToolCall key={item.key} toolCall={item.toolCall} />
            ))}
            {streamingBrowserTool && (
              <CompactStreamingTool name={streamingBrowserTool.name} partialInput={streamingBrowserTool.partialInput} />
            )}
            <div ref={bottomSentinelRef} />
          </div>
        </ScrollArea>
      )}
    </>
  )
}

const STREAMING_TOOL_FIELDS = ['streamingToolUses', 'activeSubagents'] as const

function sameStreamingTools(a: StreamingTool[], b: StreamingTool[]): boolean {
  return a.length === b.length && a.every((tool, i) =>
    tool.id === b[i].id && tool.name === b[i].name && tool.partialInput === b[i].partialInput)
}

/**
 * Renders nothing. The stream replaces `activeSubagents` on every token a
 * subagent streams, which is most of the time a browser is open, so whoever
 * subscribes to it re-renders per token. This component is that subscriber;
 * the log hears from it only when the browser tools being streamed (the main
 * agent's first, then each subagent's) actually change.
 */
function StreamingBrowserToolsWatcher({ sessionId, agentSlug, onChange }: BrowserActivityLogProps & {
  onChange: (tools: StreamingTool[]) => void
}) {
  const { streamingToolUses, activeSubagents } = useMessageStream(sessionId, agentSlug, STREAMING_TOOL_FIELDS)
  const reported = useRef(NO_STREAMING_TOOLS)

  // Before paint, so the log never shows a frame without a tool that has started.
  useLayoutEffect(() => {
    const tools: StreamingTool[] = []
    for (const tool of streamingToolUses) {
      if (tool.name.startsWith(BROWSER_TOOL_PREFIX)) tools.push(tool)
    }
    for (const sub of activeSubagents ?? []) {
      if (sub.streamingToolUse?.name.startsWith(BROWSER_TOOL_PREFIX)) tools.push(sub.streamingToolUse)
    }
    if (sameStreamingTools(reported.current, tools)) return
    reported.current = tools
    onChange(tools.length > 0 ? tools : NO_STREAMING_TOOLS)
  }, [streamingToolUses, activeSubagents, onChange])

  return null
}

function sameMessages(a: ApiMessageOrBoundary[] | undefined, b: ApiMessageOrBoundary[] | undefined): boolean {
  return a === b || (!!a && !!b && a.length === b.length && a.every((message, i) => message === b[i]))
}

/**
 * Renders nothing. Reports one subagent's transcript to the log, only when
 * its messages or older pages change: a refetch that brings nothing new keeps
 * every message's identity, and does not re-render the log.
 */
function SubagentTranscriptWatcher({ sessionId, agentSlug, subagentId, onChange }: BrowserActivityLogProps & {
  subagentId: string
  onChange: (subagentId: string, transcript: SubagentTranscript | undefined) => void
}) {
  const { data, hasOlder, fetchOlder } = useSubagentMessages(sessionId, agentSlug, subagentId)
  const reported = useRef<SubagentTranscript | undefined>(undefined)
  // fetchOlder changes with every page; the log calls it only on a click.
  const latestFetchOlder = useRef(fetchOlder)
  const stableFetchOlder = useCallback(() => latestFetchOlder.current(), [])

  useLayoutEffect(() => {
    latestFetchOlder.current = fetchOlder
    const last = reported.current
    if (last && sameMessages(last.messages, data) && last.hasOlder === hasOlder) return
    reported.current = { messages: data, hasOlder, fetchOlder: stableFetchOlder }
    onChange(subagentId, reported.current)
  }, [data, hasOlder, fetchOlder, stableFetchOlder, subagentId, onChange])

  useLayoutEffect(() => () => onChange(subagentId, undefined), [subagentId, onChange])

  return null
}

// Memoized on the tool call's identity, which the query layer's structural
// sharing keeps across refetches until that call's own data changes.
const CompactToolCall = memo(function CompactToolCall({ toolCall }: { toolCall: ApiToolCall }) {
  const [expanded, setExpanded] = useState(false)
  const renderer = getToolRenderer(toolCall.name)
  const Icon = renderer?.icon
  const summary = renderer?.getSummary?.(toolCall.input)
  // Parsing tries JSON.parse on the whole result, and a page snapshot is
  // large. A closed row needs it only to learn whether it has anything to open.
  const needsResult = expanded || !toolCall.input
  const resultText = useMemo(
    () => (needsResult ? parseToolResult(toolCall.result).text : null),
    [needsResult, toolCall.result],
  )
  const hasDetail = !!(resultText || toolCall.input)

  const isError = toolCall.isError

  return (
    <div className="text-xs rounded-item border border-border/30 px-2 py-1">
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
      {expanded && resultText && (
        <pre className={cn(
          'ml-5 mt-0.5 mb-1 text-2xs leading-snug whitespace-pre-wrap break-words rounded p-1.5 max-h-32 overflow-y-auto',
          isError
            ? 'bg-red-50/50 text-red-700/70 dark:bg-red-950/30 dark:text-red-300/70'
            : 'bg-muted/30 text-muted-foreground/70'
        )}>
          {resultText}
        </pre>
      )}
    </div>
  )
})

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
