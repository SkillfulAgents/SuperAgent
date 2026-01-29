
import { KeyRound } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface RequestSecretInput {
  secretName?: string
  reason?: string
}

function parseRequestSecretInput(input: unknown): RequestSecretInput {
  if (typeof input === 'object' && input !== null) {
    return input as RequestSecretInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { secretName } = parseRequestSecretInput(input)
  if (secretName) {
    return secretName
  }
  return null
}

function parseResult(result: unknown): string | null {
  if (!result) return null

  // Already-parsed array of content blocks: [{type: "text", text: "..."}]
  if (Array.isArray(result) && result[0]?.text) {
    return result[0].text
  }

  // Already-parsed single content block: {type: "text", text: "..."}
  if (typeof result === 'object' && result !== null && 'text' in result) {
    return (result as { text: string }).text
  }

  if (typeof result === 'string') {
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

  return String(result)
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { secretName, reason } = parseRequestSecretInput(input)
  const displayResult = parseResult(result)

  return (
    <div className="space-y-2">
      {/* Secret name */}
      {secretName && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Secret</div>
          <div className="bg-background rounded p-2 text-xs font-mono">
            {secretName}
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
  let parsed: RequestSecretInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Secret</div>
        <div className="bg-background rounded p-2 text-xs font-mono">
          {parsed.secretName || <span className="text-muted-foreground italic">...</span>}
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

export const requestSecretRenderer: ToolRenderer = {
  displayName: 'Request Secret',
  icon: KeyRound,
  getSummary,
  ExpandedView,
  StreamingView,
}
