
import { cn } from '@shared/lib/utils/cn'
import { Circle, CheckCircle, XCircle, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react'
import { useState, useRef } from 'react'
import { getToolRenderer } from './tool-renderers'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import type { ApiToolCall } from '@shared/lib/types/api'

interface ToolCallItemProps {
  toolCall: ApiToolCall
  messageCreatedAt?: Date | string
  agentSlug?: string
}

interface StreamingToolCallItemProps {
  name: string
  partialInput: string
}

type ToolCallStatus = 'running' | 'success' | 'error'

function getStatus(toolCall: ApiToolCall): ToolCallStatus {
  if (toolCall.result === null || toolCall.result === undefined) return 'running'
  if (toolCall.isError) return 'error'
  return 'success'
}

export function ToolCallItem({ toolCall, messageCreatedAt, agentSlug }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false)
  const status = getStatus(toolCall)
  const renderer = getToolRenderer(toolCall.name)
  const elapsed = useElapsedTimer(status === 'running' ? (messageCreatedAt ?? null) : null)

  const StatusIcon = {
    running: Circle,
    success: CheckCircle,
    error: XCircle,
  }[status]

  const statusColor = {
    running: 'text-gray-400',
    success: 'text-green-500',
    error: 'text-red-500',
  }[status]

  // Get custom icon if available
  const ToolIcon = renderer?.icon || Wrench

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
    <div className="border rounded-md bg-muted/30 text-sm" data-testid={`tool-call-${toolCall.name}`}>
      {/* Header row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        {/* Status indicator */}
        <StatusIcon
          className={cn(
            'h-4 w-4 shrink-0',
            statusColor,
            status === 'running' && 'animate-pulse'
          )}
        />

        {/* Tool icon */}
        <ToolIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

        {/* Tool name and summary */}
        <span className="font-mono font-medium truncate">
          {renderer?.displayName || toolCall.name}
        </span>

        {/* Summary in collapsed view */}
        {summary && (
          <span className="text-muted-foreground truncate text-xs">
            {summary}
          </span>
        )}

        {/* Elapsed timer for running tool calls */}
        {elapsed && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {elapsed}
          </span>
        )}

        {/* Expand chevron */}
        <span className={cn('shrink-0', !elapsed && 'ml-auto')}>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3">
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
                      'rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto',
                      toolCall.isError ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-background'
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

  // Get custom icon if available
  const ToolIcon = renderer?.icon || Wrench

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
    <div className="border rounded-md bg-muted/30 text-sm">
      {/* Header row - always expanded during streaming */}
      <div className="w-full flex items-center gap-2 px-3 py-2">
        {/* Status indicator - streaming */}
        <Loader2 className="h-4 w-4 shrink-0 text-gray-400 animate-spin" />

        {/* Tool icon */}
        <ToolIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

        {/* Tool name */}
        <span className="font-mono font-medium truncate">
          {renderer?.displayName || name}
        </span>

        {/* Summary if available */}
        {summary && (
          <span className="text-muted-foreground truncate text-xs">
            {summary}
          </span>
        )}

        {/* Elapsed timer */}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {elapsed}
        </span>
      </div>

      {/* Always show input during streaming */}
      <div className="px-3 pb-3">
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
