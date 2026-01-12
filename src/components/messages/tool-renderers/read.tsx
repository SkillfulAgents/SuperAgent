'use client'

import { FileText } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface ReadInput {
  file_path?: string
  offset?: number
  limit?: number
}

function parseReadInput(input: unknown): ReadInput {
  if (typeof input === 'object' && input !== null) {
    return input as ReadInput
  }
  return {}
}

function getDisplayPath(filePath: string): string {
  // Show shortened path for common prefixes
  if (filePath.startsWith('/workspace/')) {
    return filePath.replace('/workspace/', '')
  }
  return filePath
}

function getSummary(input: unknown): string | null {
  const { file_path } = parseReadInput(input)
  if (file_path) {
    return getDisplayPath(file_path)
  }
  return null
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { file_path, offset, limit } = parseReadInput(input)

  return (
    <div className="space-y-2">
      {/* File path */}
      {file_path && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">File</div>
          <div className="bg-background rounded p-2 text-xs font-mono truncate">
            {file_path}
            {(offset !== undefined || limit !== undefined) && (
              <span className="text-muted-foreground ml-2">
                {offset !== undefined && `offset: ${offset}`}
                {offset !== undefined && limit !== undefined && ', '}
                {limit !== undefined && `limit: ${limit}`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      {result && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : 'Content'}
          </div>
          <pre
            className={`rounded p-2 text-xs overflow-x-auto max-h-60 overflow-y-auto font-mono ${
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
  let parsed: ReadInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">File</div>
        <pre className="bg-background rounded p-2 text-xs overflow-x-auto font-mono whitespace-pre-wrap break-all">
          {parsed.file_path || <span className="text-muted-foreground italic">...</span>}
          <span className="animate-pulse">|</span>
        </pre>
      </div>
    </div>
  )
}

export const readRenderer: ToolRenderer = {
  icon: FileText,
  getSummary,
  ExpandedView,
  StreamingView,
}
