
import { Terminal } from 'lucide-react'
import { bashDef, type BashInput } from '@shared/lib/tool-definitions/bash'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { command } = bashDef.parseInput(input)

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
  displayName: bashDef.displayName,
  icon: Terminal,
  getSummary: bashDef.getSummary,
  ExpandedView,
  StreamingView,
}
