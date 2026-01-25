
import { Link2 } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { getProvider } from '@shared/lib/composio/providers'

interface RequestConnectedAccountInput {
  toolkit?: string
  reason?: string
}

function parseRequestConnectedAccountInput(input: unknown): RequestConnectedAccountInput {
  if (typeof input === 'object' && input !== null) {
    return input as RequestConnectedAccountInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { toolkit } = parseRequestConnectedAccountInput(input)
  if (toolkit) {
    const provider = getProvider(toolkit.toLowerCase())
    return provider?.displayName || toolkit
  }
  return null
}

function parseResult(result: string | null): string | null {
  if (!result) return null

  // Try to parse JSON array format from MCP response
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

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { toolkit, reason } = parseRequestConnectedAccountInput(input)
  const displayResult = parseResult(result ?? null)
  const provider = toolkit ? getProvider(toolkit.toLowerCase()) : null

  return (
    <div className="space-y-2">
      {/* Toolkit */}
      {toolkit && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Service</div>
          <div className="bg-background rounded p-2 text-xs font-medium capitalize">
            {provider?.displayName || toolkit}
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
  let parsed: RequestConnectedAccountInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  const provider = parsed.toolkit ? getProvider(parsed.toolkit.toLowerCase()) : null

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Service</div>
        <div className="bg-background rounded p-2 text-xs font-medium capitalize">
          {provider?.displayName || parsed.toolkit || (
            <span className="text-muted-foreground italic">...</span>
          )}
        </div>
      </div>
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

export const requestConnectedAccountRenderer: ToolRenderer = {
  displayName: 'Request Connected Account',
  icon: Link2,
  getSummary,
  ExpandedView,
  StreamingView,
}
