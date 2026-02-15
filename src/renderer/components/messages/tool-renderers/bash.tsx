
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
    <div className="rounded-md bg-black overflow-hidden">
      <div className="p-3 font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto">
        {/* Command line */}
        {command && (
          <pre className="text-white font-bold whitespace-pre-wrap break-all m-0">
            <span className="text-gray-500 select-none">$ </span>
            {command}
          </pre>
        )}

        {/* Output */}
        {result && (
          <pre
            className={`mt-2 whitespace-pre-wrap break-all m-0 ${
              isError ? 'text-red-400' : 'text-gray-400'
            }`}
          >
            {result}
          </pre>
        )}
      </div>
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
    <div className="rounded-md bg-black overflow-hidden">
      <div className="p-3 font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto">
        {parsed.description && (
          <div className="text-gray-500 mb-1">{parsed.description}</div>
        )}
        <pre className="text-white font-bold whitespace-pre-wrap break-all m-0">
          <span className="text-gray-500 select-none">$ </span>
          {parsed.command || <span className="text-gray-600 italic">...</span>}
          <span className="animate-pulse text-gray-400">|</span>
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
