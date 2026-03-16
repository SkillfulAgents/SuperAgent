import { Terminal } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'

interface RequestScriptRunInput {
  script?: string
  explanation?: string
  scriptType?: string
}

function parseInput(input: unknown): RequestScriptRunInput {
  if (typeof input === 'object' && input !== null) {
    return input as RequestScriptRunInput
  }
  return {}
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

const SCRIPT_TYPE_LABELS: Record<string, string> = {
  applescript: 'AppleScript',
  shell: 'Shell',
  powershell: 'PowerShell',
}

function getSummary(input: unknown): string | null {
  const { scriptType, explanation } = parseInput(input)
  const typeLabel = scriptType ? SCRIPT_TYPE_LABELS[scriptType] || scriptType : ''
  const truncated = explanation && explanation.length > 60 ? explanation.slice(0, 60) + '...' : explanation
  return [typeLabel, truncated].filter(Boolean).join(': ') || null
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { script, explanation, scriptType } = parseInput(input)
  const displayResult = parseResult(result)

  return (
    <div className="space-y-2">
      {explanation && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Explanation</div>
          <div className="bg-background rounded p-2 text-xs">{explanation}</div>
        </div>
      )}

      {scriptType && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Script Type</div>
          <div className="bg-background rounded p-2 text-xs">
            {SCRIPT_TYPE_LABELS[scriptType] || scriptType}
          </div>
        </div>
      )}

      {script && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Script</div>
          <pre className="bg-background rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
            <code>{script}</code>
          </pre>
        </div>
      )}

      {displayResult && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : 'Output'}
          </div>
          <pre
            className={`rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all ${
              isError
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'
            }`}
          >
            {displayResult}
          </pre>
        </div>
      )}
    </div>
  )
}

export const requestScriptRunRenderer: ToolRenderer = {
  displayName: 'Run Script',
  icon: Terminal,
  getSummary,
  ExpandedView,
}
