'use client'

import { cn } from '@/lib/utils/cn'
import type { ToolCall } from '@/lib/db/schema'
import { Circle, CheckCircle, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

interface ToolCallItemProps {
  toolCall: ToolCall
}

type ToolCallStatus = 'running' | 'success' | 'error'

function getStatus(toolCall: ToolCall): ToolCallStatus {
  if (toolCall.result === null) return 'running'
  if (toolCall.isError) return 'error'
  return 'success'
}

export function ToolCallItem({ toolCall }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false)
  const status = getStatus(toolCall)

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

  // Format input for display
  const inputStr = typeof toolCall.input === 'string'
    ? toolCall.input
    : JSON.stringify(toolCall.input, null, 2)

  // Format result for display
  const resultStr = toolCall.result
    ? (typeof toolCall.result === 'string'
        ? toolCall.result
        : JSON.stringify(toolCall.result, null, 2))
    : null

  return (
    <div className="border rounded-md bg-muted/30 text-sm">
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

        {/* Tool name */}
        <span className="font-mono font-medium truncate">
          {toolCall.name}
        </span>

        {/* Expand chevron */}
        <span className="ml-auto shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
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
                  toolCall.isError ? 'bg-red-50 text-red-800' : 'bg-background'
                )}
              >
                {resultStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
