
import { cn } from '@shared/lib/utils/cn'
import { Check, X, Ban, ChevronDown, ChevronRight, Loader2, Search, ImageOff } from 'lucide-react'
import { useState, useRef, useMemo, memo, useCallback, useEffect } from 'react'
import { getToolRenderer } from './tool-renderers'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { toolCallHasResult, type ApiToolCall } from '@shared/lib/types/api'
import { formatToolName } from '@shared/lib/tool-definitions/types'
import { apiFetch } from '@renderer/lib/api'
import { sessionToolResultSchema, transcriptImageSchema } from '@shared/lib/services/session-transcript-schema'

export { formatToolName } from '@shared/lib/tool-definitions/types'

interface ToolCallItemProps {
  toolCall: ApiToolCall
  messageCreatedAt?: Date | string
  agentSlug?: string
  sessionId?: string
  isSessionActive?: boolean
}

interface StreamingToolCallItemProps {
  name: string
  partialInput: string
}

type ToolCallStatus = 'running' | 'success' | 'error' | 'cancelled'

function getStatus(toolCall: ApiToolCall, isSessionActive?: boolean): ToolCallStatus {
  if (!toolCallHasResult(toolCall)) {
    // Only show "running" if the caller explicitly says this tool could still be active.
    // Otherwise it was interrupted/cancelled (or is from a historical interrupted turn).
    return isSessionActive ? 'running' : 'cancelled'
  }
  if (toolCall.isError) return 'error'
  return 'success'
}

function isUserInputTool(name: string): boolean {
  return name === 'AskUserQuestion' || name.startsWith('mcp__user-input__')
}

function formatOmittedSize(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`
  if (chars >= 1_000) return `${Math.round(chars / 1_000)} KB`
  return `${chars} chars`
}

function OmittedScreenshot({
  agentSlug,
  sessionId,
  toolUseId,
  index,
  originalChars,
}: {
  agentSlug?: string
  sessionId?: string
  toolUseId: string
  index: number
  originalChars: number
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [src, setSrc] = useState<string | null>(null)
  const canLoad = Boolean(agentSlug && sessionId && toolUseId)

  const load = useCallback(async () => {
    if (!agentSlug || !sessionId || !toolUseId || status === 'loading' || status === 'ready') return
    setStatus('loading')
    try {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(toolUseId)}/images/${index}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = transcriptImageSchema.safeParse(await res.json())
      if (!parsed.success) throw new Error('Invalid image payload')
      setSrc(`data:${parsed.data.mimeType};base64,${parsed.data.data}`)
      setStatus('ready')
    } catch (error) {
      console.warn('Failed to load omitted screenshot', error)
      setStatus('error')
    }
  }, [agentSlug, sessionId, toolUseId, index, status])

  if (status === 'ready' && src) {
    return <img src={src} alt="Tool result" className="max-w-full rounded border" />
  }

  return (
    <button
      type="button"
      data-testid="omitted-screenshot"
      onClick={load}
      disabled={!canLoad || status === 'loading'}
      className="flex w-full items-center gap-2 rounded border border-dashed border-border px-2 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50 disabled:hover:bg-transparent"
    >
      {status === 'loading' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <ImageOff className="h-3.5 w-3.5 shrink-0" />}
      {status === 'loading'
        ? 'Loading screenshot…'
        : status === 'error'
          ? 'Failed to load screenshot'
          : canLoad
            ? `Screenshot omitted (${formatOmittedSize(originalChars)}) — click to load`
            : `Screenshot omitted (${formatOmittedSize(originalChars)})`}
    </button>
  )
}

function ToolNameWithSummary({ name, summary, active = false }: { name: string; summary?: string | null; active?: boolean }) {
  return (
    <>
      <span className={cn(
        'font-sans font-normal shrink-0 text-sm leading-none transition-colors',
        active ? 'text-foreground' : 'text-foreground/65 group-hover:text-foreground'
      )}>
        {name}
      </span>
      {summary && (
        <>
          <span aria-hidden className="shrink-0 text-foreground/40 group-hover:text-muted-foreground text-sm leading-none transition-colors">→</span>
          <span className="text-muted-foreground/70 group-hover:text-muted-foreground truncate text-xs leading-none transition-colors">
            {summary}
          </span>
        </>
      )}
    </>
  )
}

export function StatusIndicator({ status }: { status: string }) {
  if (status === 'success' || status === 'completed') {
    return (
      <span className="h-4 w-4 shrink-0 rounded-full bg-green-100 dark:bg-green-950/60 flex items-center justify-center">
        <Check className="h-2.5 w-2.5 text-green-600 dark:text-green-400" strokeWidth={2.5} />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="h-4 w-4 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center">
        <X className="h-2.5 w-2.5 text-muted-foreground" strokeWidth={2.5} />
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="h-4 w-4 shrink-0 flex items-center justify-center">
        <Loader2 className="h-3 w-3 text-gray-400 animate-spin" />
      </span>
    )
  }
  return (
    <span className="h-4 w-4 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center">
      <Ban className="h-2.5 w-2.5 text-muted-foreground" strokeWidth={2.5} />
    </span>
  )
}

function ToolCallItemComponent({ toolCall, messageCreatedAt, agentSlug, sessionId, isSessionActive }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState<{ result: unknown; isError: boolean } | null>(null)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle')
  const status = getStatus(toolCall, isSessionActive)
  const renderer = getToolRenderer(toolCall.name)
  const isPendingUserInput = status === 'running' && isUserInputTool(toolCall.name)
  const elapsed = useElapsedTimer(status === 'running' && !isPendingUserInput ? (messageCreatedAt ?? null) : null)
  const ToolIcon = renderer?.icon || Search
  const result = loaded?.result ?? toolCall.result
  const isError = loaded?.isError ?? toolCall.isError

  useEffect(() => {
    if (!expanded || result != null || !toolCall.hasResult || !agentSlug || !sessionId) return
    let cancelled = false
    setLoadState('loading')
    void apiFetch(
      `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(toolCall.id)}`
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const parsed = sessionToolResultSchema.safeParse(await res.json())
        if (!parsed.success) throw new Error('Invalid tool result')
        if (!cancelled) {
          setLoaded(parsed.data)
          setLoadState('idle')
        }
      })
      .catch((error) => {
        console.warn('Failed to load tool result', error)
        if (!cancelled) setLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [expanded, result, toolCall.hasResult, toolCall.id, agentSlug, sessionId])

  // Get summary for collapsed view
  const summary = useMemo(() => renderer?.getSummary?.(toolCall.input), [renderer, toolCall.input])

  // Format input for display (fallback)
  const inputStr = useMemo(
    () => (typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input, null, 2)),
    [toolCall.input]
  )

  // Parse result into text + images
  const parsed = useMemo(() => parseToolResult(result), [result])
  const resultStr = parsed.text
  const resultImages = parsed.images
  const omittedImages = parsed.omittedImages

  // Get custom expanded view if available
  const CustomExpandedView = renderer?.ExpandedView

  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden" data-testid={`tool-call-${toolCall.name}`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${toolCall.name} tool call`}
        data-testid={`tool-call-toggle-${toolCall.name}`}
        onClick={() => setExpanded((current) => !current)}
        className={cn('flex w-full items-center gap-2 pl-2 pr-2 py-1.5 group hover:bg-muted/50 transition-colors', expanded && 'bg-muted/50')}
      >
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-foreground/45 group-hover:text-foreground transition-colors" />
        {isPendingUserInput && (
          <span className="font-sans font-normal shrink-0 text-sm text-foreground/65 group-hover:text-foreground leading-none transition-colors">
            Waiting for input:
          </span>
        )}
        <ToolNameWithSummary
          name={renderer?.displayName || formatToolName(toolCall.name)}
          summary={summary}
        />
        {renderer?.CollapsedContent && (
          <>
            {!summary && <span aria-hidden className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground text-sm leading-none transition-colors">→</span>}
            <renderer.CollapsedContent
              input={toolCall.input}
              result={resultStr}
              isError={toolCall.isError ?? false}
              agentSlug={agentSlug}
            />
          </>
        )}
        {elapsed && (
          <span className="shrink-0 text-2xs text-muted-foreground/70 tabular-nums ml-auto">
            {elapsed}
          </span>
        )}
        <span className={cn(
          'relative shrink-0 flex h-4 w-4 items-center justify-center',
          !elapsed && 'ml-auto'
        )}>
          <span className="transition-opacity group-hover:opacity-0">
            <StatusIndicator status={status} />
          </span>
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity group-hover:text-muted-foreground group-hover:opacity-100">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/70 bg-muted/50 px-3 py-3">
          {loadState === 'loading' && (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading tool result…
            </div>
          )}
          {loadState === 'error' && (
            <div className="mb-2 text-xs text-muted-foreground">Failed to load tool result</div>
          )}
          {CustomExpandedView ? (
            <CustomExpandedView
              input={toolCall.input}
              result={resultStr}
              isError={isError ?? false}
              agentSlug={agentSlug}
            />
          ) : (
            // Fallback: generic JSON display
            <div className="space-y-2">
              {/* Input */}
              <div>
                <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">Input</div>
                <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto">
                  {inputStr}
                </pre>
              </div>

              {/* Output */}
              {resultStr && (
                <div>
                  <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">
                    {isError ? 'Error' : 'Output'}
                  </div>
                  <pre
                    className={cn(
                      'bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto',
                      isError && 'text-red-800 dark:text-red-200'
                    )}
                  >
                    {resultStr}
                  </pre>
                </div>
              )}
            </div>
          )}
          {/* Render images from tool results */}
          {resultImages.length > 0 && (
            <div className="mt-2 space-y-2">
              {resultImages.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt="Tool result"
                  className="max-w-full rounded border"
                />
              ))}
            </div>
          )}
          {omittedImages.length > 0 && (
            <div className="mt-2 space-y-2">
              {omittedImages.map((img, i) => (
                <OmittedScreenshot
                  key={i}
                  agentSlug={agentSlug}
                  sessionId={sessionId}
                  toolUseId={toolCall.id}
                  index={i}
                  originalChars={img.originalChars}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Memoized: a persisted tool call's props are stable across refetches (React
// Query structural sharing), so collapsed rows don't re-render when the parent
// MessageItem re-renders (e.g. while a sibling subagent streams).
export const ToolCallItem = memo(ToolCallItemComponent)

// Component for displaying a tool call while its input is being streamed
export function StreamingToolCallItem({ name, partialInput }: StreamingToolCallItemProps) {
  const startTimeRef = useRef(new Date())
  const elapsed = useElapsedTimer(startTimeRef.current)
  const renderer = getToolRenderer(name)

  // Get custom streaming view if available
  const CustomStreamingView = renderer?.StreamingView
  const ToolIcon = renderer?.icon || Search

  // Parse the partial input at most once and reuse it for both the summary and
  // the pretty-printed fallback. Skip the parse entirely when nothing consumes
  // it (a CustomStreamingView renders the body and there's no summary getter).
  let summary: string | null = null
  let displayInput = partialInput
  if (partialInput && (renderer?.getSummary || !CustomStreamingView)) {
    try {
      const parsed = JSON.parse(partialInput)
      if (!CustomStreamingView) displayInput = JSON.stringify(parsed, null, 2)
      if (renderer?.getSummary) summary = renderer.getSummary(parsed)
    } catch {
      // Partial/invalid JSON mid-stream — keep the raw partialInput, no summary.
    }
  }

  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden">
      <div className="flex w-full items-center gap-2 pl-2 pr-2 py-1.5 bg-muted/50">
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-foreground" />
        <ToolNameWithSummary
          name={renderer?.displayName || formatToolName(name)}
          summary={summary}
          active
        />
        <span className="shrink-0 text-2xs text-muted-foreground/70 tabular-nums ml-auto">
          {elapsed}
        </span>
        <StatusIndicator status="running" />
      </div>

      <div className="border-t border-border/70 bg-muted/50 px-3 py-3">
        {CustomStreamingView ? (
          <CustomStreamingView partialInput={partialInput} />
        ) : (
          // Fallback: generic display
          <div className="space-y-2">
            <div>
              <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">Input</div>
              <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                {displayInput || <span className="text-muted-foreground italic">Waiting for input...</span>}
                <span className="animate-pulse">|</span>
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
