
import { cn } from '@shared/lib/utils/cn'
import { Check, X, ChevronDown, ChevronRight, Loader2, StopCircle } from 'lucide-react'
import { useState, useRef } from 'react'
import { getToolRenderer } from './tool-renderers'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import type { ApiToolCall } from '@shared/lib/types/api'
import { formatToolName } from '@shared/lib/tool-definitions/types'

export { formatToolName } from '@shared/lib/tool-definitions/types'

interface ToolCallItemProps {
  toolCall: ApiToolCall
  messageCreatedAt?: Date | string
  agentSlug?: string
  isSessionActive?: boolean
}

interface StreamingToolCallItemProps {
  name: string
  partialInput: string
}

type ToolCallStatus = 'running' | 'success' | 'error' | 'cancelled'

function getStatus(toolCall: ApiToolCall, isSessionActive?: boolean): ToolCallStatus {
  if (toolCall.result === null || toolCall.result === undefined) {
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

function ToolNameWithSummary({ name, summary }: { name: string; summary?: string | null }) {
  return (
    <>
      <span className="font-mono font-normal truncate text-xs text-muted-foreground group-hover:text-foreground transition-colors">
        {name}
      </span>
      {summary && (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground text-xs transition-colors">→</span>
          <span className="text-muted-foreground group-hover:text-foreground truncate text-xs transition-colors">
            {summary}
          </span>
        </>
      )}
    </>
  )
}

function StatusIndicator({ status }: { status: ToolCallStatus }) {
  if (status === 'success') {
    return (
      <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-green-100 dark:bg-green-950/60 flex items-center justify-center">
        <Check className="h-2.5 w-2.5 text-green-600 dark:text-green-400" strokeWidth={3} />
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-muted flex items-center justify-center">
        <X className="h-2.5 w-2.5 text-muted-foreground" strokeWidth={3} />
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
        <Loader2 className="h-3 w-3 text-gray-400 animate-spin" />
      </span>
    )
  }
  return (
    <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
      <StopCircle className="h-3 w-3 text-gray-400" />
    </span>
  )
}

export function ToolCallItem({ toolCall, messageCreatedAt, agentSlug, isSessionActive }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false)
  const status = getStatus(toolCall, isSessionActive)
  const renderer = getToolRenderer(toolCall.name)
  const isPendingUserInput = status === 'running' && isUserInputTool(toolCall.name)
  const elapsed = useElapsedTimer(status === 'running' && !isPendingUserInput ? (messageCreatedAt ?? null) : null)

  // Get summary for collapsed view
  const summary = renderer?.getSummary?.(toolCall.input)

  // Format input for display (fallback)
  const inputStr = typeof toolCall.input === 'string'
    ? toolCall.input
    : JSON.stringify(toolCall.input, null, 2)

  // Parse result into text + images
  const parsed = parseToolResult(toolCall.result)
  const resultStr = parsed.text
  const resultImages = parsed.images

  // Get custom expanded view if available
  const CustomExpandedView = renderer?.ExpandedView

  return (
    <div className="text-sm" data-testid={`tool-call-${toolCall.name}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 py-1 group"
      >
        <StatusIndicator status={status} />
        <ToolNameWithSummary
          name={renderer?.displayName || formatToolName(toolCall.name)}
          summary={summary}
        />
        {renderer?.CollapsedContent && (
          <renderer.CollapsedContent
            input={toolCall.input}
            result={resultStr}
            isError={toolCall.isError ?? false}
            agentSlug={agentSlug}
          />
        )}
        {isPendingUserInput && (
          <span className="shrink-0 text-2xs text-muted-foreground">
            waiting for user input
          </span>
        )}
        {elapsed && (
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {elapsed}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 rounded-md bg-muted px-3 py-3">
          {CustomExpandedView ? (
            <CustomExpandedView
              input={toolCall.input}
              result={resultStr}
              isError={toolCall.isError ?? false}
              agentSlug={agentSlug}
            />
          ) : (
            // Fallback: generic JSON display
            <div className="space-y-2">
              {/* Input */}
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
                <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto">
                  {inputStr}
                </pre>
              </div>

              {/* Output */}
              {resultStr && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    {toolCall.isError ? 'Error' : 'Output'}
                  </div>
                  <pre
                    className={cn(
                      'bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto',
                      toolCall.isError && 'text-red-800 dark:text-red-200'
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
        </div>
      )}
    </div>
  )
}

// Component for displaying a tool call while its input is being streamed
export function StreamingToolCallItem({ name, partialInput }: StreamingToolCallItemProps) {
  const startTimeRef = useRef(new Date())
  const elapsed = useElapsedTimer(startTimeRef.current)
  const renderer = getToolRenderer(name)

  // Get custom streaming view if available
  const CustomStreamingView = renderer?.StreamingView

  // Try to get summary from partial input
  let summary: string | null = null
  if (renderer?.getSummary) {
    try {
      const parsed = JSON.parse(partialInput)
      summary = renderer.getSummary(parsed)
    } catch {
      // Can't parse yet, no summary
    }
  }

  // Fallback: Try to pretty-print the partial JSON if it's valid
  let displayInput = partialInput
  if (partialInput) {
    try {
      const parsed = JSON.parse(partialInput)
      displayInput = JSON.stringify(parsed, null, 2)
    } catch {
      // Show raw partial input as-is
      displayInput = partialInput
    }
  }

  return (
    <div className="text-sm">
      <div className="flex w-full items-center gap-2 py-1">
        <StatusIndicator status="running" />
        <ToolNameWithSummary
          name={renderer?.displayName || formatToolName(name)}
          summary={summary}
        />
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          {elapsed}
        </span>
      </div>

      <div className="mt-1 rounded-md bg-muted px-3 py-3">
        {CustomStreamingView ? (
          <CustomStreamingView partialInput={partialInput} />
        ) : (
          // Fallback: generic display
          <div className="space-y-2">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Input</div>
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
