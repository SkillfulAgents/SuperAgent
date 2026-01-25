
import { Terminal } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface BashInput {
  command?: string
  description?: string
}

function parseBashInput(input: unknown): BashInput {
  if (typeof input === 'object' && input !== null) {
    return input as BashInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { command, description } = parseBashInput(input)

  // Prefer description if available
  if (description) {
    return description
  }

  // Otherwise show truncated command
  if (command) {
    const firstLine = command.split('\n')[0]
    if (firstLine.length > 50) {
      return `$ ${firstLine.slice(0, 47)}...`
    }
    return `$ ${firstLine}`
  }

  return null
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { command } = parseBashInput(input)

  return (
    <div className="space-y-2">
      {/* Command */}
      {command && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Command</div>
          <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto font-mono">
            <span className="text-muted-foreground select-none">$ </span>
            {command}
          </pre>
        </div>
      )}

      {/* Output */}
      {result && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : 'Output'}
          </div>
          <pre
            className={`rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto font-mono ${
              isError ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-background'
            }`}
          >
            {result}
          </pre>
        </div>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: BashInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming, show raw
  }

  return (
    <div className="space-y-2">
      {parsed.description && (
        <div className="text-xs text-muted-foreground">{parsed.description}</div>
      )}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Command</div>
        <pre className="bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto font-mono whitespace-pre-wrap break-all">
          <span className="text-muted-foreground select-none">$ </span>
          {parsed.command || <span className="text-muted-foreground italic">...</span>}
          <span className="animate-pulse">|</span>
        </pre>
      </div>
    </div>
  )
}

export const bashRenderer: ToolRenderer = {
  icon: Terminal,
  getSummary,
  ExpandedView,
  StreamingView,
}
