
import { Plug } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface RequestRemoteMcpInput {
  url?: string
  name?: string
  reason?: string
}

function parseInput(input: unknown): RequestRemoteMcpInput {
  if (typeof input === 'object' && input !== null) {
    return input as RequestRemoteMcpInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { name, url } = parseInput(input)
  return name || url || null
}

function parseResult(result: unknown): string | null {
  if (!result) return null

  if (Array.isArray(result) && result[0]?.text) {
    return result[0].text
  }

  if (typeof result === 'object' && result !== null && 'text' in result) {
    return (result as { text: string }).text
  }

  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed) && parsed[0]?.text) {
        return parsed[0].text
      }
    } catch {
      // Not JSON, use as-is
    }
    return result
  }

  return String(result)
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { url, name, reason } = parseInput(input)
  const displayResult = parseResult(result)

  return (
    <div className="space-y-2">
      {/* Server name */}
      {name && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Server</div>
          <div className="bg-background rounded p-2 text-xs font-medium">
            {name}
          </div>
        </div>
      )}

      {/* URL */}
      {url && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">URL</div>
          <div className="bg-background rounded p-2 text-xs font-mono truncate">
            {url}
          </div>
        </div>
      )}

      {/* Reason */}
      {reason && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Reason</div>
          <div className="bg-background rounded p-2 text-xs">
            {reason}
          </div>
        </div>
      )}

      {/* Result */}
      {displayResult && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : 'Result'}
          </div>
          <div
            className={`rounded p-2 text-xs ${
              isError
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'
            }`}
          >
            {displayResult}
          </div>
        </div>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: RequestRemoteMcpInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Server</div>
        <div className="bg-background rounded p-2 text-xs font-medium">
          {parsed.name || parsed.url || (
            <span className="text-muted-foreground italic">...</span>
          )}
        </div>
      </div>
      {parsed.url && parsed.name && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">URL</div>
          <div className="bg-background rounded p-2 text-xs font-mono truncate">
            {parsed.url}
            <span className="animate-pulse">|</span>
          </div>
        </div>
      )}
      {parsed.reason && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Reason</div>
          <div className="bg-background rounded p-2 text-xs">
            {parsed.reason}
            <span className="animate-pulse">|</span>
          </div>
        </div>
      )}
    </div>
  )
}

export const requestRemoteMcpRenderer: ToolRenderer = {
  displayName: 'Request MCP Server',
  icon: Plug,
  getSummary,
  ExpandedView,
  StreamingView,
}
