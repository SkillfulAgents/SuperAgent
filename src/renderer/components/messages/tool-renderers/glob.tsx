
import { FolderSearch } from 'lucide-react'
import { globDef } from '@shared/lib/tool-definitions/glob'
import type { ToolRenderer, ToolRendererProps } from './types'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { pattern, path } = globDef.parseInput(input)

  const files = result ? result.split('\n').filter(Boolean) : []

  return (
    <div className="space-y-2">
      {/* Pattern and path */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">Pattern</div>
        <div className="bg-background rounded p-2 text-xs font-mono">
          {pattern}
          {path && (
            <span className="text-muted-foreground ml-2">in {path}</span>
          )}
        </div>
      </div>

      {/* File list */}
      {(files.length > 0 || isError) && result && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : `Files (${files.length})`}
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

      {/* No results */}
      {!isError && result !== null && result !== undefined && files.length === 0 && (
        <div className="text-xs text-muted-foreground italic">No files matched</div>
      )}
    </div>
  )
}

export const globRenderer: ToolRenderer = {
  displayName: globDef.displayName,
  icon: FolderSearch,
  getSummary: globDef.getSummary,
  ExpandedView,
}
