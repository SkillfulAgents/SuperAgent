
import { Hand } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { requestBrowserInputDef, type RequestBrowserInputInput } from '@shared/lib/tool-definitions/request-browser-input'

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
  const { message, requirements } = requestBrowserInputDef.parseInput(input)
  const displayResult = parseResult(result)

  return (
    <div className="space-y-2">
      {/* Message */}
      {message && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">Message</div>
          <div className="bg-background rounded p-2 text-xs">
            {message}
          </div>
        </div>
      )}

      {/* Requirements */}
      {requirements && requirements.length > 0 && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">Requirements</div>
          <ul className="bg-background rounded p-2 text-xs list-disc list-inside space-y-0.5">
            {requirements.map((req, i) => (
              <li key={i}>{req}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Result */}
      {displayResult && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">
            {isError ? 'Error' : 'Result'}
          </div>
          <div
            className={`bg-background rounded p-2 text-xs ${
              isError
                ? 'text-red-800 dark:text-red-200'
                : 'text-green-800 dark:text-green-200'
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
  let parsed: RequestBrowserInputInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">Message</div>
        <div className="bg-background rounded p-2 text-xs">
          {parsed.message || <span className="text-muted-foreground italic">...</span>}
          <span className="animate-pulse">|</span>
        </div>
      </div>
      {parsed.requirements && parsed.requirements.length > 0 && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">Requirements</div>
          <ul className="bg-background rounded p-2 text-xs list-disc list-inside space-y-0.5">
            {parsed.requirements.map((req, i) => (
              <li key={i}>{req}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export const requestBrowserInputRenderer: ToolRenderer = {
  displayName: 'Request Browser Input',
  icon: Hand,
  getSummary: requestBrowserInputDef.getSummary,
  ExpandedView,
  StreamingView,
}
